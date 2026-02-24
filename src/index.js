require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const alertCooldownSeconds = Number(process.env.ALERT_COOLDOWN_SECONDS || 300);
const dmDelayMs = Number(process.env.DM_DELAY_MS || 1200);
const rateLimitMaxRetries = Number(process.env.RATE_LIMIT_MAX_RETRIES || 5);
const rateLimitBufferMs = Number(process.env.RATE_LIMIT_BUFFER_MS || 250);

if (!token || !clientId) {
  throw new Error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables.');
}

const commandBuilder = new SlashCommandBuilder()
  .setName('alert')
  .setDescription('Send a consent-based alert DM to all members with a selected role.')
  .addRoleOption((option) =>
    option
      .setName('role')
      .setDescription('Only members with this role will be messaged.')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('message')
      .setDescription('Message content to send.')
      .setRequired(true)
      .setMaxLength(1800)
  )
  .addBooleanOption((option) =>
    option
      .setName('show_sender')
      .setDescription('Show the initiating admin in the DM (default: true).')
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const slashCommands = [commandBuilder.toJSON()];

const rest = new REST({ version: '10' }).setToken(token);

const cooldownByGuild = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function getRetryAfterMs(error) {
  const retryAfterSeconds =
    error?.data?.retry_after ??
    error?.rawError?.retry_after ??
    error?.retry_after;

  if (typeof retryAfterSeconds !== 'number' || Number.isNaN(retryAfterSeconds)) {
    return null;
  }

  return Math.max(0, Math.ceil(retryAfterSeconds * 1000) + rateLimitBufferMs);
}

async function sendDmWithRateLimitRetry(member, content) {
  let lastError;

  for (let attempt = 0; attempt <= rateLimitMaxRetries; attempt += 1) {
    try {
      await member.send({ content });
      return true;
    } catch (error) {
      lastError = error;

      const isRateLimited = error?.status === 429;
      if (!isRateLimited) {
        break;
      }

      const retryAfterMs = getRetryAfterMs(error);
      if (retryAfterMs === null) {
        break;
      }

      if (attempt >= rateLimitMaxRetries) {
        break;
      }

      await sleep(retryAfterMs);
    }
  }

  if (lastError?.status === 429) {
    console.warn(
      `Rate limit retries exhausted while DMing ${member.user.tag}.`
    );
  }

  return false;
}

async function registerCommandsForGuild(guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: slashCommands,
  });
}

function getRemainingCooldown(guildId) {
  const lastRun = cooldownByGuild.get(guildId);
  if (!lastRun) {
    return 0;
  }

  const nextAllowedAt = lastRun + alertCooldownSeconds * 1000;
  return Math.max(0, nextAllowedAt - Date.now());
}

async function handleAlertCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'This command can only be used inside a server.',
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'Only administrators can use this command.',
      ephemeral: true,
    });
    return;
  }

  const remainingCooldown = getRemainingCooldown(interaction.guildId);
  if (remainingCooldown > 0) {
    const secondsLeft = Math.ceil(remainingCooldown / 1000);
    await interaction.reply({
      content: `This server is on cooldown. Try again in ${secondsLeft}s.`,
      ephemeral: true,
    });
    return;
  }

  const role = interaction.options.getRole('role', true);
  const message = interaction.options.getString('message', true);
  const showSender = interaction.options.getBoolean('show_sender') ?? true;

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  await guild.members.fetch();

  const targets = role.members.filter((member) => !member.user.bot);

  if (targets.size === 0) {
    await interaction.editReply(
      `No non-bot members found with role ${role}. Nothing was sent.`
    );
    return;
  }

  cooldownByGuild.set(interaction.guildId, Date.now());

  let sentCount = 0;
  let failedCount = 0;
  const startedAt = new Date();
  const estimatedDurationMs = targets.size * dmDelayMs;
  const estimatedFinishAt = startedAt.getTime() + estimatedDurationMs;
  const estimatedDurationLabel = formatDuration(estimatedDurationMs);

  if (interaction.channel && interaction.channel.isTextBased()) {
    const startMessage = [
      `🚀 ${interaction.user} started an alert run.`,
      `Role: ${role}`,
      `Targets: ${targets.size}`,
      `Started: <t:${Math.floor(startedAt.getTime() / 1000)}:F>`,
      `Estimated Duration: ~${estimatedDurationLabel} (without retries)`,
      `Estimated Finish: <t:${Math.floor(estimatedFinishAt / 1000)}:F>`,
    ].join('\n');

    try {
      await interaction.channel.send({ content: startMessage });
    } catch (error) {
      console.warn('Unable to post start message in channel:', error?.message || error);
    }
  }

  const alertHeader = showSender
    ? `📣 Alert from **${interaction.user.tag}** in **${guild.name}**`
    : `📣 Alert from **${guild.name} Administration**`;

  for (const member of targets.values()) {
    const dmContent = [alertHeader, '', message].join('\n');

    const sent = await sendDmWithRateLimitRetry(member, dmContent);
    if (sent) {
      sentCount += 1;
    } else {
      failedCount += 1;
    }

    await sleep(dmDelayMs);
  }

  const durationMs = Date.now() - startedAt.getTime();
  const durationLabel = formatDuration(durationMs);

  await interaction.editReply(
    `Finished sending alert to role ${role}. Sent: ${sentCount}, failed: ${failedCount}, duration: ${durationLabel}, cooldown: ${alertCooldownSeconds}s.`
  );

  if (interaction.channel && interaction.channel.isTextBased()) {
    const completionMessage = [
      `✅ ${interaction.user} alert execution completed.`,
      `Role: ${role}`,
      `Sent: ${sentCount}`,
      `Failed: ${failedCount}`,
      `Duration: ${durationLabel}`,
    ].join('\n');

    try {
      await interaction.channel.send({ content: completionMessage });
    } catch (error) {
      console.warn('Unable to post completion message in channel:', error?.message || error);
    }
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guilds = await client.guilds.fetch();
  for (const [guildId] of guilds) {
    try {
      await registerCommandsForGuild(guildId);
      console.log(`Registered commands for guild ${guildId}`);
    } catch (error) {
      console.error(`Failed to register commands for guild ${guildId}:`, error);
    }
  }
});

client.on('guildCreate', async (guild) => {
  try {
    await registerCommandsForGuild(guild.id);
    console.log(`Registered commands for new guild ${guild.id}`);
  } catch (error) {
    console.error(`Failed to register commands for new guild ${guild.id}:`, error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName !== 'alert') {
    return;
  }

  try {
    await handleAlertCommand(interaction);
  } catch (error) {
    console.error('Error handling /alert command:', error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('Something went wrong while processing the alert command.');
      return;
    }

    await interaction.reply({
      content: 'Something went wrong while processing the alert command.',
      ephemeral: true,
    });
  }
});

client.login(token);