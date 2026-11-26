import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.js'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
export declare const name: 'tool-mbot'
export declare const inject: string[]
export interface ToolRequest {
  action: 'boot' | 'status' | 'lint' | 'board_show' | 'board_add' | 'board_set' | 'task_show' | 'task_result' | 'remember'
  bot?: string
  task_id?: string
  text?: string
  state?: 'todo' | 'doing' | 'blocked' | 'done'
  owner?: string
  reason?: string
  as?: string
}
export declare const actions: ToolRequest['action'][]
export declare function toolCommand(args: ToolRequest): { program: 'mbot' | 'botctl'; argv: string[]; input?: string }
export declare function apply(ctx: Context): void
