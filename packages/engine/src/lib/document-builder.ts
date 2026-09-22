import { mkdir, mkdtemp, readFile, rm, writeFile, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, posix, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { EngineError } from '../errors.ts';

const execFileAsync = promisify(execFile);
const SCRIPT = `
const inputPath = Argument["input"];
const outputPath = Argument["output"];
const format = Argument["format"];
const options = Argument["options"] || {};
builderJS.SetTmpFolder(Argument["tmp"]);
if (!builderJS.OpenFile(inputPath, "")) throw new Error("The input document could not be opened");
if (options.mode === "word-to-pdf") {
  const document = Api.GetDocument();
  const sizes = { a4: [11906, 16838], a5: [8391, 11906], letter: [12240, 15840] };
  const size = sizes[options.pageSize] || sizes.a4;
  const margin = Math.round((Number(options.marginPt) || 0) * 20);
  const sections = document.GetSections();
  for (let i = 0; i < sections.length; i += 1) {
    sections[i].SetPageMargins(margin, margin, margin, margin);
    sections[i].SetPageSize(size[0], size[1], true);
  }
}
if (options.mode === "excel-to-pdf") {
  const sheets = Api.GetSheets();
  if (options.orientation !== "auto") {
    const orientation = options.orientation === "landscape" ? "xlLandscape" : "xlPortrait";
    for (let i = 0; i < sheets.length; i += 1) sheets[i].SetPageOrientation(orientation);
  }
}
builderJS.SaveFile(format, outputPath);
builderJS.CloseFile();
`;

type BuilderOptions = {
  mode?: 'word-to-pdf' | 'excel-to-pdf' | 'ppt-to-pdf';
  pageSize?: string;
  marginPt?: number;
  orientation?: string;
  repeatHeader?: boolean;
  fontPath?: string | null;
};

type BuilderManifest = { version: string; executable: string; root: string };

function inside(base: string, candidate: string): boolean {
  const relative = resolve(candidate).slice(resolve(base).length);
  return relative === '' || relative.startsWith(sep);
}

async function findExecutable(): Promise<{ executable: string; cwd: string }> {
  const explicit = process.env.POTOOLS_DOCUMENTBUILDER;
  if (explicit) {
    const executable = resolve(explicit);
    try {
      await access(executable, constants.X_OK);
    } catch {
      throw new EngineError('unsupported', '配置的 ONLYOFFICE Document Builder 程序不可用。');
    }
    return { executable, cwd: dirname(executable) };
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const roots = [
    process.env.POTOOLS_RESOURCE_DIR,
    process.env.POTOOLS_ENGINE_DIR,
    moduleDir,
    resolve(process.cwd(), 'dist'),
    resolve(moduleDir, '../../dist'),
    process.cwd(),
    ...process.env.PATH?.split(delimiter) ?? [],
  ].filter((value): value is string => Boolean(value));

  for (const candidate of roots) {
    const manifestPath = candidate.endsWith('documentbuilder-manifest.json')
      ? candidate
      : join(candidate, 'documentbuilder-manifest.json');
    let manifest: BuilderManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuilderManifest;
    } catch {
      continue;
    }
    if (!manifest.executable || !manifest.root) continue;
    const base = dirname(manifestPath);
    const root = resolve(base, manifest.root);
    const executable = resolve(root, manifest.executable);
    if (!inside(base, root) || !inside(root, executable)) continue;
    try {
      await access(executable, constants.X_OK);
      return { executable, cwd: root };
    } catch {
      continue;
    }
  }
  throw new EngineError(
    'unsupported',
    '本机 Office 转换引擎未安装到应用资源中。请在打包时配置 Document Builder；运行期间不会联网下载。',
  );
}

async function convertWithLibreOffice(
  executable: string,
  source: string,
  outputExtension: string,
  temp: string,
): Promise<Uint8Array> {
  const profile = join(temp, 'profile');
  await mkdir(profile, { recursive: true });
  try {
    await execFileAsync(executable, [
      '--headless',
      '--norestore',
      '--convert-to', outputExtension,
      '--outdir', temp,
      '-env:UserInstallation=file://' + profile,
      source,
    ], {
      cwd: temp,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    });
  } catch (error) {
    const detail = error instanceof Error ? (error.message.split(/\r?\n/, 1)[0] ?? '转换失败').slice(0, 300) : '转换失败';
    throw new EngineError('unreadable_file', `Office 文件无法转换：${detail}`);
  }
  const output = join(temp, `source.${outputExtension}`);
  const info = await stat(output).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new EngineError('unreadable_file', 'Office 转换引擎没有生成有效的输出文件。');
  }
  return new Uint8Array(await readFile(output));
}

export async function convertOfficeLocally(
  bytes: Uint8Array,
  inputExtension: string,
  outputExtension: string,
  options: BuilderOptions = {},
): Promise<Uint8Array> {
  const temp = await mkdtemp(join(tmpdir(), 'potools-document-convert-'));
  const source = join(temp, `source.${inputExtension}`);
  const output = join(temp, `result.${outputExtension}`);
  const script = join(temp, 'convert.js');
  const builderTemp = join(temp, 'builder-tmp');
  try {
    const preparedBytes = options.mode === 'excel-to-pdf'
      ? await prepareWorkbookForPdf(bytes, options)
      : bytes;
    await Promise.all([
      writeFile(source, preparedBytes),
      writeFile(script, SCRIPT),
      mkdir(builderTemp),
    ]);
    const argument = JSON.stringify({
      input: source,
      output,
      format: outputExtension,
      tmp: builderTemp,
      options,
    });
    try {
      const { executable, cwd } = await findExecutable();
      const args = [`--argument=${argument}`];
      if (options.fontPath) args.push(`--fonts-dir=${dirname(options.fontPath)}`);
      args.push(script);
      await execFileAsync(executable, args, {
        cwd,
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
      });
      const info = await stat(output).catch(() => null);
      if (!info?.isFile() || info.size === 0) {
        throw new EngineError('unreadable_file', 'Office 转换引擎没有生成有效的输出文件。');
      }
      return new Uint8Array(await readFile(output));
    } catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'unsupported') throw error;
      const libreOffice = process.env.POTOOLS_LIBREOFFICE ?? 'soffice';
      return await convertWithLibreOffice(libreOffice, source, outputExtension, temp);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function xmlAttributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]));
}

function upsertXmlAttribute(attributes: string, name: string, value: string | null): string {
  const without = attributes.replace(/\/\s*$/, '').replace(new RegExp(`\\s${name}="[^"]*"`, 'g'), '');
  return value === null ? without : `${without} ${name}="${value}"`;
}

async function prepareWorkbookForPdf(bytes: Uint8Array, options: BuilderOptions): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const workbookFile = zip.file('xl/workbook.xml');
  if (!workbookFile) throw new EngineError('unreadable_file', 'Excel 工作簿缺少 xl/workbook.xml。');
  const workbookPath = 'xl/workbook.xml';
  const relationshipsPath = 'xl/_rels/workbook.xml.rels';
  const relationshipsFile = zip.file(relationshipsPath);
  if (!relationshipsFile) throw new EngineError('unreadable_file', 'Excel 工作簿缺少工作表关系信息。');
  let workbookXml = await workbookFile.async('string');
  const relationshipsXml = await relationshipsFile.async('string');
  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const attributes = xmlAttributes(match[0]);
    if (attributes.Id && attributes.Target && !attributes.TargetMode?.toLowerCase().includes('external')) {
      const target = attributes.Target.startsWith('/') ? attributes.Target.slice(1) : posix.join('xl', attributes.Target);
      relationships.set(attributes.Id, posix.normalize(target));
    }
  }
  const sheetEntries = [...workbookXml.matchAll(/<sheet\b[^>]*\/?\s*>/g)].map((match) => xmlAttributes(match[0]));
  if (sheetEntries.length === 0) throw new EngineError('unreadable_file', 'Excel 工作簿中没有工作表。');
  const paperSize = ({ letter: '1', a3: '8', a4: '9' } as Record<string, string>)[options.pageSize ?? 'a4'] ?? '9';
  const repeatNames: string[] = [];

  for (const [index, sheet] of sheetEntries.entries()) {
    const sheetPath = relationships.get(sheet['r:id'] ?? '');
    if (!sheetPath || !zip.file(sheetPath)) continue;
    let sheetXml = await zip.file(sheetPath)!.async('string');
    const pageSetup = /<pageSetup\b([^>]*)\/?\s*>/;
    const currentSetup = sheetXml.match(pageSetup);
    const currentAttributes = currentSetup?.[1] ?? '';
    let updatedAttributes = upsertXmlAttribute(currentAttributes, 'paperSize', paperSize);
    const orientation = options.orientation === 'portrait' || options.orientation === 'landscape'
      ? options.orientation
      : null;
    updatedAttributes = upsertXmlAttribute(updatedAttributes, 'orientation', orientation);
    const newSetup = `<pageSetup${updatedAttributes}/>`;
    if (currentSetup?.index !== undefined) {
      sheetXml = sheetXml.slice(0, currentSetup.index) + newSetup + sheetXml.slice(currentSetup.index + currentSetup[0].length);
    } else {
      const pageMargins = /<pageMargins\b[^>]*\/?\s*>/;
      const margins = sheetXml.match(pageMargins);
      if (margins?.index !== undefined) {
        const insertAt = margins.index + margins[0].length;
        sheetXml = sheetXml.slice(0, insertAt) + newSetup + sheetXml.slice(insertAt);
      } else {
        const closingTag = sheetXml.lastIndexOf('</worksheet>');
        if (closingTag >= 0) sheetXml = sheetXml.slice(0, closingTag) + newSetup + sheetXml.slice(closingTag);
      }
    }
    zip.file(sheetPath, sheetXml);
    if (options.repeatHeader && sheet.name) {
      repeatNames.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${xmlEscape(`'${sheet.name.replaceAll("'", "''")}'!$1:$1`)}</definedName>`);
    }
  }

  if (repeatNames.length > 0) {
    const namesPattern = /<definedNames\b[^>]*>[\s\S]*?<\/definedNames>/;
    const existingNames = workbookXml.match(namesPattern);
    const originalNames = existingNames?.[0] ?? '<definedNames></definedNames>';
    const preservedNames = originalNames.replace(/<definedName\b(?=[^>]*name="_xlnm\.Print_Titles")[^>]*>[\s\S]*?<\/definedName>/g, '');
    const nextNames = preservedNames.replace('</definedNames>', `${repeatNames.join('')}</definedNames>`);
    if (existingNames?.index !== undefined) {
      workbookXml = workbookXml.slice(0, existingNames.index) + nextNames + workbookXml.slice(existingNames.index + existingNames[0].length);
    } else {
      const insertion = workbookXml.search(/<(?:calcPr|oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|webPublishObjects|extLst)\b/);
      const at = insertion >= 0 ? insertion : workbookXml.lastIndexOf('</workbook>');
      workbookXml = workbookXml.slice(0, at) + nextNames + workbookXml.slice(at);
    }
  }
  zip.file(workbookPath, workbookXml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 3 } });
}
