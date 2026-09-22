import type { ToolImpl } from '../types.ts';
import { cryptoEncodingTools } from './crypto-encoding.ts';
import { cryptoPrimitivesTools } from './crypto-primitives.ts';

export const cryptoTools: ToolImpl[] = [...cryptoEncodingTools, ...cryptoPrimitivesTools];
