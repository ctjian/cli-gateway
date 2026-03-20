export type BuiltinCommandName =
  | 'help'
  | 'ui'
  | 'cli'
  | 'workspace'
  | 'cron'
  | 'new'
  | 'stop'
  | 'last'
  | 'replay'
  | 'allow'
  | 'deny'
  | 'whitelist';

export type BuiltinCommandDefinition = {
  name: BuiltinCommandName;
  description: string;
  helpLine: string;
};

const BUILTIN_COMMANDS: BuiltinCommandDefinition[] = [
  {
    name: 'help',
    description: '显示可用命令',
    helpLine: '/help - 显示帮助',
  },
  {
    name: 'ui',
    description: '查看或设置界面模式',
    helpLine: '/ui verbose|summary - 设置输出展示模式',
  },
  {
    name: 'cli',
    description: '查看或切换 CLI 预设',
    helpLine: '/cli show|codex|claude - 查看或切换后端',
  },
  {
    name: 'workspace',
    description: '查看或设置工作目录',
    helpLine: '/workspace show|<absolute-path> - 查看或设置工作目录',
  },
  {
    name: 'cron',
    description: '管理定时任务',
    helpLine: '/cron help - 查看定时任务帮助',
  },
  {
    name: 'new',
    description: '重置当前会话',
    helpLine: '/new - 新建会话',
  },
  {
    name: 'stop',
    description: '停止当前任务并保留会话',
    helpLine: '/stop - 停止当前运行中的任务',
  },
  {
    name: 'last',
    description: '查看最近一次输出',
    helpLine: '/last - 查看最近一次运行结果',
  },
  {
    name: 'replay',
    description: '重放历史输出',
    helpLine: '/replay [runId] - 重放指定或最近一次输出',
  },
  {
    name: 'allow',
    description: '批准待处理权限请求',
    helpLine: '/allow <n> - 允许第 n 个待确认权限',
  },
  {
    name: 'deny',
    description: '拒绝待处理权限请求',
    helpLine: '/deny - 拒绝当前待确认权限',
  },
  {
    name: 'whitelist',
    description: '管理权限白名单',
    helpLine: '/whitelist list|add|del|clear - 管理权限白名单',
  },
];

const BUILTIN_COMMANDS_BY_NAME = new Map(
  BUILTIN_COMMANDS.map((command) => [command.name, command]),
);

const INLINE_COMMAND_DESC_ZH = new Map<string, string>([
  ['review', '审查当前改动'],
  ['review-branch', '对比指定分支审查改动'],
  ['research-lit', '快速查找相关工作'],
]);

export function listBuiltinCommands(): BuiltinCommandDefinition[] {
  return BUILTIN_COMMANDS.map((command) => ({ ...command }));
}

export function listBuiltinHelpLines(): string[] {
  return BUILTIN_COMMANDS.map((command) => command.helpLine);
}

export function listTelegramBuiltinCommands(): Array<{
  command: string;
  description: string;
}> {
  return BUILTIN_COMMANDS.map((command) => ({
    command: command.name,
    description: command.description,
  }));
}

export function getBuiltinCommand(
  name: string,
): BuiltinCommandDefinition | undefined {
  const command = BUILTIN_COMMANDS_BY_NAME.get(name as BuiltinCommandName);
  return command ? { ...command } : undefined;
}

export function localizeInlineCommandDescription(
  name: string,
  description: string,
): string {
  const rawName = String(name ?? '').trim();
  const rawDescription = String(description ?? '').trim();

  if (containsCjk(rawDescription)) return rawDescription;

  const mapped = INLINE_COMMAND_DESC_ZH.get(rawName);
  if (mapped) return mapped;

  const normalized = rawDescription.toLowerCase();
  if (normalized.includes('related work')) return '快速查找相关工作';
  if (normalized.includes('current changes')) return '审查当前改动';
  if (normalized.includes('branch')) return '对比指定分支审查改动';
  if (normalized.includes('review')) return '执行审查相关操作';
  return rawDescription || rawName;
}

export function toTelegramCommandName(name: string): string | null {
  const normalized = name
    .trim()
    .toLowerCase()
    .replaceAll('-', '_')
    .replace(/[^a-z0-9_]/g, '');

  if (!normalized) return null;
  if (normalized.length > 32) return null;
  if (!/^[a-z]/.test(normalized)) return null;
  return normalized;
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}
