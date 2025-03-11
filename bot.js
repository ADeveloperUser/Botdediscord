const { Client, GatewayIntentBits, AuditLogEvent } = require('discord.js');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks
    ]
});

const messageTracker = new Map();
const webhookTracker = new Map();
const webhookCreationLogs = new Map();
const TIME_LIMIT = 5 * 60 * 1000; // 5 minutos
const MAX_ACTIONS = 3; // Limite de mensajes permitidos en un tiempo determinado
const SPAM_THRESHOLD = 3; // Umbral de creación de webhooks en el tiempo determinado
const TIME_FRAME = 5 * 60 * 1000; // 5 minutos

client.on('ready', () => {
    console.log(`Bot conectado como ${client.user.tag}`);
});

// Función para obtener el usuario que realizó una acción
async function getAuditUser(guild, actionType) {
    const logs = await guild.fetchAuditLogs({ type: actionType, limit: 1 });
    const entry = logs.entries.first();
    return entry ? entry.executor.id : null;
}

client.on('channelCreate', async (channel) => {
    const userId = await getAuditUser(channel.guild, AuditLogEvent.ChannelCreate);
    if (userId) handleAction(channel.guild, userId, 'channelCreate');
});

client.on('channelDelete', async (channel) => {
    const userId = await getAuditUser(channel.guild, AuditLogEvent.ChannelDelete);
    if (userId) handleAction(channel.guild, userId, 'channelDelete');
});

client.on('roleCreate', async (role) => {
    const userId = await getAuditUser(role.guild, AuditLogEvent.RoleCreate);
    if (userId) handleAction(role.guild, userId, 'roleCreate');
});

client.on('roleDelete', async (role) => {
    const userId = await getAuditUser(role.guild, AuditLogEvent.RoleDelete);
    if (userId) handleAction(role.guild, userId, 'roleDelete');
});

// Maneja las acciones como creación/eliminación de canales/roles
function handleAction(guild, userId, actionType) {
    if (!userId) return;
    const key = `${guild.id}-${userId}-${actionType}`;
    const userActions = messageTracker.get(key) || [];
    const now = Date.now();

    userActions.push(now);
    messageTracker.set(key, userActions.filter(t => now - t < TIME_LIMIT));

    if (messageTracker.get(key).length > MAX_ACTIONS) {
        const member = guild.members.cache.get(userId);
        if (member && member.bannable) {
            member.ban({ reason: 'Creación o eliminación masiva de canales/roles' });
            console.log(`Usuario ${member.user.tag} baneado por abuso de canales/roles.`);
        }
        messageTracker.delete(key);
    }
}

// Función para manejar el spam de webhooks
client.on('webhookUpdate', async (channel) => {
    const now = Date.now();
    const guildId = channel.guild.id;
    
    // Registrar las creaciones de webhooks
    if (!webhookCreationLogs.has(guildId)) {
        webhookCreationLogs.set(guildId, []);
    }

    const logs = webhookCreationLogs.get(guildId);
    logs.push(now);

    // Eliminar registros fuera del marco temporal
    while (logs.length > 0 && now - logs[0] > TIME_FRAME) {
        logs.shift();
    }

    // Si el número de webhooks creados supera el umbral, banea al usuario
    if (logs.length >= SPAM_THRESHOLD) {
        const auditLogs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate });
        const entry = auditLogs.entries.first();
        if (entry) {
            const user = entry.executor;
            await channel.guild.members.ban(user.id, { reason: 'Spam de webhooks detectado' }).catch(() => {});
        }
        logs.length = 0; // Limpiar los registros después de banear
    }
    
    // Eliminar los webhooks creados por spam
    const webhooks = await channel.fetchWebhooks();
    webhooks.forEach(async (webhook) => {
        await webhook.delete('Anti-spam de webhooks').catch(() => {});
    });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return; // Ignorar los mensajes de otros bots

    // Verificar si el mensaje proviene de un webhook
    if (message.webhookId) {
        console.log(`Mensaje recibido de Webhook: ${message.content}`);
        handleWebhookSpam(message);
    }
});

// Función para manejar el spam de webhooks
async function handleWebhookSpam(message) {
    const webhookId = message.webhookId;
    const now = Date.now();
    const key = `${message.guild.id}-${webhookId}`;

    // Rastrear los mensajes de webhooks
    const messages = webhookTracker.get(key) || [];
    webhookTracker.set(key, [...messages.filter(t => now - t < TIME_LIMIT), now]);

    console.log(`Tracking webhook ${webhookId} with messages:`, webhookTracker.get(key));

    // Si el webhook supera el límite de mensajes permitidos
    if (webhookTracker.get(key).length > MAX_ACTIONS) {
        try {
            // Obtener el webhook por su ID
            const webhook = await message.guild.fetchWebhook(webhookId);
            console.log(`Webhook encontrado: ${webhook.name}`);

            // Eliminar el webhook si excede el límite
            await webhook.delete('Eliminación de webhook por spam');
            console.log(`Webhook ${webhook.name} eliminado por spam.`);
        } catch (error) {
            console.error('Error al eliminar webhook:', error);
        }
        webhookTracker.delete(key); // Limpiar el registro del webhook
    }
};
client.login('');
