import type { ToolImpl } from '../types.ts';
import { timeBasicTools } from './time-basic.ts';
import { timeExtraTools } from './time-extra.ts';

export const timeTools: ToolImpl[] = [...timeBasicTools, ...timeExtraTools];
