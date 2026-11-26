import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.js'
import type {} from '@deepseek-ai/dsh-commands'
export declare const name: 'command-mbot'
export declare const inject: string[]
export declare const usage: string
export declare function commandArgs(raw: string): { program: 'mbot' | 'botctl'; argv: string[] } | null
export declare function apply(ctx: Context): void
