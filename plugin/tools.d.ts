import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.js'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
export declare const name: 'tool-mbot'
export declare const inject: string[]
export interface ToolRequest {
  action: 'boot' | 'status' | 'lint' | 'board_show' | 'board_add' | 'board_set' | 'task_show' | 'task_result' | 'remember' | import('./runtime.js').WorkerAction
  bot?: string
  task_id?: string
  text?: string
  state?: 'todo' | 'doing' | 'blocked' | 'done'
  owner?: string
  reason?: string
  as?: string
  worker_id?: string
}
export declare const actions: ToolRequest['action'][]
export declare function toolCommand(args: ToolRequest): { program: 'mbot' | 'botctl'; argv: string[]; input?: string }
/** Trusted Agent-scoped shadow; controls are exposed only to enabled Chief Sessions. */
export declare function registerBotctl(ctx: Context, options?: { workers?: boolean; role?: string }): () => void
export declare function apply(ctx: Context): void
