import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import {
  getBuiltinCommand,
  listBuiltinCommands,
} from '../gateway/commandCatalog.js';
import { TOOL_KINDS } from '../gateway/toolAuth.js';

export type DiscordSlashInteractionLike = {
  commandName: string;
  options: {
    getString: (name: string, required?: boolean) => string | null;
    getInteger: (name: string, required?: boolean) => number | null;
    getSubcommand: (...args: any[]) => string | null;
  };
};

export function buildDiscordSlashCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const builders = listBuiltinCommands().map((command) => {
    switch (command.name) {
      case 'ui':
        return new SlashCommandBuilder()
          .setName(command.name)
          .setDescription(command.description)
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('verbose, summary, or show')
              .setRequired(false)
              .addChoices(
                { name: 'show', value: 'show' },
                { name: 'verbose', value: 'verbose' },
                { name: 'summary', value: 'summary' },
              ),
          );
      case 'cli':
        return new SlashCommandBuilder()
          .setName(command.name)
          .setDescription(command.description)
          .addStringOption((opt) =>
            opt
              .setName('preset')
              .setDescription('show, codex, or claude')
              .setRequired(false)
              .addChoices(
                { name: 'show', value: 'show' },
                { name: 'codex', value: 'codex' },
                { name: 'claude', value: 'claude' },
              ),
          );
      case 'workspace':
        return new SlashCommandBuilder()
          .setName(command.name)
          .setDescription(command.description)
          .addStringOption((opt) =>
            opt
              .setName('path')
              .setDescription('absolute path, or ~ / ~/...')
              .setRequired(false),
          );
      case 'replay':
        return new SlashCommandBuilder()
          .setName(command.name)
          .setDescription(command.description)
          .addStringOption((opt) =>
            opt.setName('run_id').setDescription('Run ID').setRequired(false),
          );
      case 'allow':
        return new SlashCommandBuilder()
          .setName(command.name)
          .setDescription(command.description)
          .addIntegerOption((opt) =>
            opt
              .setName('index')
              .setDescription('1-based permission option index')
              .setRequired(true)
              .setMinValue(1),
          );
      case 'whitelist':
        return new SlashCommandBuilder()
          .setName(command.name)
          .setDescription(command.description)
          .addSubcommand((sub) =>
            sub.setName('list').setDescription('List whitelisted tool kinds'),
          )
          .addSubcommand((sub) =>
            sub
              .setName('add')
              .setDescription('Add a whitelisted tool kind')
              .addStringOption((opt) =>
                TOOL_KINDS.reduce(
                  (builder, kind) => builder.addChoices({ name: kind, value: kind }),
                  opt
                    .setName('tool_kind')
                    .setDescription('Tool kind to whitelist')
                    .setRequired(true),
                ),
              )
              .addStringOption((opt) =>
                opt
                  .setName('prefix')
                  .setDescription('Optional path/argument prefix')
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('del')
              .setDescription('Remove a tool kind from whitelist')
              .addStringOption((opt) =>
                TOOL_KINDS.reduce(
                  (builder, kind) => builder.addChoices({ name: kind, value: kind }),
                  opt
                    .setName('tool_kind')
                    .setDescription('Tool kind to remove')
                    .setRequired(true),
                ),
              )
              .addStringOption((opt) =>
                opt
                  .setName('prefix')
                  .setDescription('Optional path/argument prefix')
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub.setName('clear').setDescription('Clear whitelist entries'),
          );
      case 'cron':
        return new SlashCommandBuilder()
          .setName(command.name)
          .setDescription(command.description)
          .addSubcommand((sub) =>
            sub.setName('help').setDescription('Show cron usage'),
          )
          .addSubcommand((sub) => sub.setName('list').setDescription('List jobs'))
          .addSubcommand((sub) =>
            sub
              .setName('add')
              .setDescription('Add a scheduler job')
              .addStringOption((opt) =>
                opt
                  .setName('expr')
                  .setDescription('Cron expr: m h dom mon dow')
                  .setRequired(true),
              )
              .addStringOption((opt) =>
                opt
                  .setName('prompt')
                  .setDescription('Prompt template')
                  .setRequired(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('del')
              .setDescription('Delete a job')
              .addStringOption((opt) =>
                opt
                  .setName('job_id')
                  .setDescription('Job ID')
                  .setRequired(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('enable')
              .setDescription('Enable a job')
              .addStringOption((opt) =>
                opt
                  .setName('job_id')
                  .setDescription('Job ID')
                  .setRequired(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('disable')
              .setDescription('Disable a job')
              .addStringOption((opt) =>
                opt
                  .setName('job_id')
                  .setDescription('Job ID')
                  .setRequired(true),
              ),
          );
      default:
        return new SlashCommandBuilder()
          .setName(command.name)
          .setDescription(command.description);
    }
  });

  return builders.map((b) => b.toJSON());
}

export function mapDiscordSlashToRouterCommand(
  interaction: DiscordSlashInteractionLike,
): string | null {
  const cmd = interaction.commandName.toLowerCase();

  switch (cmd) {
    case 'help':
    case 'new':
    case 'stop':
    case 'last':
    case 'deny':
      return `/${cmd}`;
    case 'ui': {
      const mode = interaction.options.getString('mode');
      return mode ? `/ui ${mode}` : '/ui';
    }
    case 'cli': {
      const preset = interaction.options.getString('preset');
      return preset ? `/cli ${preset}` : '/cli show';
    }
    case 'workspace': {
      const raw = interaction.options.getString('path');
      const pathArg = raw?.trim();
      return pathArg ? `/workspace ${pathArg}` : '/workspace show';
    }
    case 'replay': {
      const runId = interaction.options.getString('run_id');
      return runId ? `/replay ${runId}` : '/replay';
    }
    case 'allow': {
      const idx = interaction.options.getInteger('index', true);
      return idx ? `/allow ${idx}` : '/allow';
    }
    case 'whitelist': {
      const sub = interaction.options.getSubcommand(true) ?? 'list';
      if (sub === 'add' || sub === 'del') {
        const toolKind = interaction.options.getString('tool_kind', true);
        const prefix = interaction.options.getString('prefix');
        if (!toolKind) return '/whitelist list';
        const trimmedPrefix = prefix?.trim();
        return trimmedPrefix
          ? `/whitelist ${sub} ${toolKind} ${trimmedPrefix}`
          : `/whitelist ${sub} ${toolKind}`;
      }
      return `/whitelist ${sub}`;
    }
    case 'cron': {
      const sub = interaction.options.getSubcommand(true) ?? 'help';
      if (sub === 'add') {
        const expr = interaction.options.getString('expr', true);
        const prompt = interaction.options.getString('prompt', true);
        return `/cron add ${expr} ${prompt}`;
      }
      if (sub === 'del' || sub === 'enable' || sub === 'disable') {
        const jobId = interaction.options.getString('job_id', true);
        return `/cron ${sub} ${jobId}`;
      }
      return `/cron ${sub}`;
    }
    default:
      return getBuiltinCommand(cmd) ? `/${cmd}` : null;
  }
}
