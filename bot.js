const { Client, GatewayIntentBits, AuditLogEvent, SlashCommandBuilder } = require('discord.js');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildMessageReactions,
    ]
});

const messageTracker = new Map();
const webhookMessageTracker = new Map();
const webhookCreationLogs = new Map();
const banTracker = new Map();
const TIME_LIMIT = 5 * 60 * 1000; // 5 minutos
const MAX_ACTIONS = 3; // Limite de mensajes permitidos en un tiempo determinado
const SPAM_THRESHOLD = 3; // Umbral de creación de webhooks en el tiempo determinado
const TIME_FRAME = 5 * 60 * 1000; // 5 minutos
const BAN_THRESHOLD = 5; // Umbral de baneos para activar la acción
const MAX_REPEAT_MESSAGES = 3; // Máximo de mensajes repetidos permitidos
const MAX_REPEAT_THRESHOLD = 5 * 60 * 1000; // 5 minutos para detectar spam de mensajes repetidos

client.on('ready', () => {
    console.log(`Bot conectado como ${client.user.tag}`);

    // Crear el comando /alerta
    client.application.commands.create(
        new SlashCommandBuilder()
            .setName('alerta')
            .setDescription('Registrar un evento sospechoso manualmente')
            .addStringOption(option =>
                option.setName('mensaje')
                    .setDescription('Describe el evento sospechoso')
                    .setRequired(true)
            )
    );
});

// Función para crear el canal de logs si no existe
async function createLogChannel(guild) {
    const existingChannel = guild.channels.cache.find(ch => ch.name === 'logs');
    if (!existingChannel) {
        await guild.channels.create({
            name: 'logs',
            type: 0, // Canal de texto
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: ['SEND_MESSAGES'],
                },
            ],
        });
    }
}

// Función para manejar el spam de mensajes repetidos
async function handleMessageSpam(message) {
    const userId = message.author.id;
    const messageContent = message.content;
    const now = Date.now();
    const key = `${userId}-${messageContent}`;

    // Rastrear los mensajes del usuario
    const messages = messageTracker.get(key) || [];
    messageTracker.set(key, [...messages.filter(t => now - t < MAX_REPEAT_THRESHOLD), now]);

    console.log(`Tracking spam para el usuario ${message.author.tag} con el mensaje: ${messageContent}`);

    // Si el usuario supera el umbral de mensajes repetidos
    const recentMessages = messageTracker.get(key);
    if (recentMessages.length > MAX_REPEAT_MESSAGES) {
        // Eliminar el mensaje de spam
        await message.delete();

        // Notificar en el canal de logs
        const logChannel = message.guild.channels.cache.find(ch => ch.name === 'logs');
        if (logChannel) {
            logChannel.send(`**Spam de mensajes detectado**: El usuario ${message.author.tag} fue detectado enviando el siguiente mensaje repetidamente: ${messageContent}`);
        }

        // Informar al usuario
        await message.author.send({
            content: `¡Has sido detectado enviando mensajes repetidos! Por favor, evita el spam.`
        }).catch(() => {});

        console.log(`Mensaje repetido eliminado por el usuario ${message.author.tag}: ${messageContent}`);
    }
}

// Función para registrar eventos manuales de alerta
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    if (commandName === 'alerta') {
        const message = interaction.options.getString('mensaje');
        const logChannel = interaction.guild.channels.cache.find(ch => ch.name === 'logs');

        // Enviar la alerta al canal de logs
        if (logChannel) {
            logChannel.send(`**Alerta:** ${message} - Reportado por ${interaction.user.tag}`);
        }

        // Informar al usuario que la alerta ha sido registrada
        await interaction.reply({ content: `Tu alerta ha sido registrada: "${message}"`, ephemeral: true });
    }
});

// Función para obtener el usuario que realizó una acción (como creación de canal, rol, etc.)
async function getAuditUser(guild, actionType) {
    try {
        const logs = await guild.fetchAuditLogs({ type: actionType, limit: 1 });
        const entry = logs.entries.first();
        return entry ? entry.executor.id : null;
    } catch (error) {
        console.error('Error al obtener los registros de auditoría:', error);
        return null;
    }
}

// Función para manejar acciones de creación/eliminación de canales y roles
async function handleAction(guild, userId, actionType) {
    if (!userId) return;
    const key = `${guild.id}-${userId}-${actionType}`;
    const userActions = messageTracker.get(key) || [];
    const now = Date.now();

    userActions.push(now);
    messageTracker.set(key, userActions.filter(t => now - t < TIME_LIMIT));

    console.log(`Acción de tipo ${actionType} registrada para el usuario ${userId}`);

    if (messageTracker.get(key).length > MAX_ACTIONS) {
        const member = guild.members.cache.get(userId);
        if (member && member.bannable) {
            await member.ban({ reason: 'Creación o eliminación masiva de canales/roles.' });
            console.log(`Usuario ${member.user.tag} baneado por abuso de canales/roles.`);
        }
        messageTracker.delete(key);
    }
}

// Detectar la creación y eliminación de canales, roles, y demás eventos sospechosos
client.on('channelCreate', async (channel) => {
    const userId = await getAuditUser(channel.guild, AuditLogEvent.ChannelCreate);
    if (userId) {
        console.log(`Creación de canal detectada por el usuario ${userId}`);
        handleAction(channel.guild, userId, 'channelCreate');
    }
});

client.on('channelDelete', async (channel) => {
    const userId = await getAuditUser(channel.guild, AuditLogEvent.ChannelDelete);
    if (userId) {
        console.log(`Eliminación de canal detectada por el usuario ${userId}`);
        handleAction(channel.guild, userId, 'channelDelete');
    }
});

client.on('roleCreate', async (role) => {
    const userId = await getAuditUser(role.guild, AuditLogEvent.RoleCreate);
    if (userId) {
        console.log(`Creación de rol detectada por el usuario ${userId}`);
        handleAction(role.guild, userId, 'roleCreate');
    }
});

client.on('roleDelete', async (role) => {
    const userId = await getAuditUser(role.guild, AuditLogEvent.RoleDelete);
    if (userId) {
        console.log(`Eliminación de rol detectada por el usuario ${userId}`);
        handleAction(role.guild, userId, 'roleDelete');
    }
});

// Función para manejar el spam de webhooks
async function handleWebhookSpam(message) {
    const webhookId = message.webhookId;
    const now = Date.now();
    const key = `${message.guild.id}-${webhookId}`;
    const messageContent = message.content;

    // Rastrear los mensajes de webhooks
    const messages = webhookMessageTracker.get(key) || [];
    webhookMessageTracker.set(key, [...messages.filter(t => now - t < TIME_LIMIT), { time: now, content: messageContent }]);

    console.log(`Tracking webhook ${webhookId} con mensajes:`, webhookMessageTracker.get(key));

    // Si el webhook supera el límite de mensajes repetidos
    const recentMessages = webhookMessageTracker.get(key);
    const duplicateMessages = recentMessages.filter(msg => msg.content === messageContent);

    if (duplicateMessages.length > MAX_ACTIONS) {
        try {
            // Obtener el webhook por su ID
            const webhook = await message.guild.fetchWebhook(webhookId);
            console.log(`Webhook encontrado: ${webhook.name}`);

            // Eliminar el webhook si excede el límite de mensajes repetidos
            await webhook.delete('Eliminación de webhook por spam de mensajes repetidos');
            console.log(`Webhook ${webhook.name} eliminado por spam de mensajes repetidos.`);
        } catch (error) {
            console.error('Error al eliminar webhook:', error);
        }
        webhookMessageTracker.delete(key); // Limpiar el registro del webhook
    }
}

// Detectar la creación masiva de webhooks
client.on('webhookUpdate', async (channel) => {
    const now = Date.now();
    const guildId = channel.guild.id;

    if (!webhookCreationLogs.has(guildId)) {
        webhookCreationLogs.set(guildId, []);
    }

    const logs = webhookCreationLogs.get(guildId);
    logs.push(now);

    // Eliminar registros fuera del marco temporal
    while (logs.length > 0 && now - logs[0] > TIME_FRAME) {
        logs.shift();
    }

    console.log(`Se crearon ${logs.length} webhooks en los últimos ${TIME_FRAME / 1000} segundos.`);

    // Si el número de webhooks creados supera el umbral, banea al usuario
    if (logs.length >= SPAM_THRESHOLD) {
        const auditLogs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate });
        const entry = auditLogs.entries.first();
        if (entry) {
            const user = entry.executor;
            await channel.guild.members.ban(user.id, { reason: 'Spam de webhooks detectado' }).catch(() => {});
            console.log(`Usuario ${user.tag} baneado por spam de webhooks.`);
        }
        logs.length = 0; // Limpiar los registros después de banear
    }

    // Eliminar los webhooks creados por spam
    const webhooks = await channel.fetchWebhooks();
    webhooks.forEach(async (webhook) => {
        await webhook.delete('Anti-spam de webhooks').catch(() => {});
        console.log(`Webhook ${webhook.name} eliminado por spam.`);
    });
});

// Función para detectar bots no verificados
client.on('guildMemberAdd', async (member) => {
    if (member.user.bot && !member.user.verified) {
        await member.kick('Bot no verificado');
        console.log(`Bot no verificado ${member.user.tag} expulsado.`);
    }
});

// Función para detectar baneos masivos
client.on('guildBanAdd', async (guild, user) => {
    const now = Date.now();
    if (!user || !user.id) {
        console.log('Usuario no encontrado o sin ID en el evento guildBanAdd');
        return;
    }

    const key = `${guild.id}-${user.id}`;
    const bans = banTracker.get(key) || [];
    bans.push(now);
    banTracker.set(key, bans.filter(t => now - t < TIME_LIMIT));

    console.log(`Baneo de usuario ${user.tag} registrado.`);

    // Si se banean demasiados usuarios en un corto tiempo
    if (banTracker.get(key).length >= BAN_THRESHOLD) {
        const member = guild.members.cache.get(user.id);
        if (member && member.bannable) {
            await member.ban({ reason: 'Baneos masivos realizados en poco tiempo.' });
            console.log(`Usuario ${member.user.tag} baneado por realizar demasiados baneos en poco tiempo.`);
        }
        banTracker.delete(key);
    }
});

// Verificación de enlaces sospechosos
client.on('messageCreate', async (message) => {
    const suspiciousLinks = /https?:\/\/[^\s]+/g;
    const suspiciousPatterns = /(bit\.ly|t\.co|goo\.gl)/i; // Detectar acortadores de URL comunes

    if (suspiciousLinks.test(message.content) || suspiciousPatterns.test(message.content)) {
        console.log(`Mensaje sospechoso detectado por ${message.author.tag}: ${message.content}`);

        await message.delete();

        const logChannel = message.guild.channels.cache.find(ch => ch.name === 'logs');
        if (logChannel) {
            logChannel.send(`**Mensaje sospechoso detectado**: ${message.author.tag} intentó compartir un enlace sospechoso: ${message.content}`);
        }

        await message.author.send({
            content: `Se ha eliminado tu mensaje por contener enlaces sospechosos.`
        }).catch(() => {});

        console.log(`Enlace sospechoso eliminado: ${message.content}`);
    }
});

//Aqui pon tu token de tu bot de discord
client.login('');
