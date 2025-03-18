const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, SlashCommandBuilder, ChannelType } = require('discord.js');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildModeration,
    ]
});

let logsChannelId = '1333535634845077526'; // ID del canal de logs predeterminado

// Estructuras para trackear spam y acciones
const userSpam = new Map();
const webhookSpam = new Map();
const creationTracker = new Map();
const deletionTracker = new Map();
const roleDeletionTracker = new Map();
const tokenRegex = /[A-Za-z\d]{24}\.[A-Za-z\d]{6}\.[A-Za-z\d-_]{27}/;

// Configuraciones de límites
const messageLimit = 5; // Limite de mensajes por webhook
const timeLimit = 3000; // Tiempo en milisegundos (3 segundos)
const userSpamLimit = 5; // Mensajes máximos para detectar spam de usuarios
const userSpamTimeLimit = 3000; // Tiempo para spam de usuario en milisegundos (3 segundos)

// Eventos
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Anti-tokens
    if (tokenRegex.test(message.content)) {
        await message.delete();
        message.channel.send(`${message.author}, no compartas tokens!`).then(msg => setTimeout(() => msg.delete(), 5000));
        logAction(`⚠️ **Posible Token Detectado** por ${message.author.tag} en ${message.channel}`);
    }

    // Anti-spam de usuarios
    if (!userSpam.has(message.author.id)) {
        userSpam.set(message.author.id, { count: 1, lastMessage: Date.now() });
    } else {
        let data = userSpam.get(message.author.id);
        let timeDiff = Date.now() - data.lastMessage;
        if (timeDiff < userSpamTimeLimit) {
            data.count++;
            if (data.count > userSpamLimit) {
                await message.member.timeout(10 * 60 * 1000, 'Spam de mensajes');
                logAction(`🚫 **${message.author.tag} ha sido sancionado por spam.**`);
            }
        } else {
            data.count = 1;
        }
        data.lastMessage = Date.now();
        userSpam.set(message.author.id, data);
    }

    // Detección de spam de webhook
    if (message.author.bot && message.webhookId) {
        if (!webhookSpam.has(message.webhookId)) {
            webhookSpam.set(message.webhookId, { count: 1, lastMessage: Date.now() });
        } else {
            let data = webhookSpam.get(message.webhookId);
            let timeDiff = Date.now() - data.lastMessage;
            if (timeDiff < timeLimit) {
                data.count++;
                if (data.count > messageLimit) {
                    const webhook = await message.guild.fetchWebhook(message.webhookId);
                    if (webhook) {
                        await webhook.delete();
                        logAction(`🚨 **Spam de Webhooks detectado en ${message.channel.name}.** | Webhook: ${message.webhookId} | Mensajes en los últimos ${timeLimit / 1000} segundos: ${data.count} | Webhook eliminado.`);
                    }
                }
            } else {
                data.count = 1;
            }
            data.lastMessage = Date.now();
            webhookSpam.set(message.webhookId, data);
        }
    }
});

client.on('webhookUpdate', async (channel) => {
    if (!webhookSpam.has(channel.id)) webhookSpam.set(channel.id, { count: 1, lastTime: Date.now() });
    else {
        let data = webhookSpam.get(channel.id);
        let diff = Date.now() - data.lastTime;
        if (diff < 5000) {
            data.count++;
            if (data.count > 3) {
                logAction(`🚨 **Spam de Webhooks detectado en ${channel.name}.**`);
            }
        } else {
            data.count = 1;
        }
        data.lastTime = Date.now();
        webhookSpam.set(channel.id, data);
    }
});

client.on('channelCreate', async (channel) => {
    let userId = channel.guild.ownerId;
    if (!creationTracker.has(userId)) creationTracker.set(userId, { count: 1, lastTime: Date.now() });
    else {
        let data = creationTracker.get(userId);
        let timeDiff = Date.now() - data.lastTime;
        if (timeDiff < 10000) {
            data.count++;
            if (data.count > 3) {
                await channel.delete();
                logAction(`🚫 **Creación masiva de canales detectada y bloqueada.**`);
            }
        } else {
            data.count = 1;
        }
        data.lastTime = Date.now();
        creationTracker.set(userId, data);
    }
    logAction(`📢 **Nuevo canal creado: ${channel.name}**`);
});

client.on('channelDelete', async (channel) => {
    let userId = channel.guild.ownerId;
    if (!deletionTracker.has(userId)) deletionTracker.set(userId, { count: 1, lastTime: Date.now() });
    else {
        let data = deletionTracker.get(userId);
        let timeDiff = Date.now() - data.lastTime;
        if (timeDiff < 10000) {
            data.count++;
            if (data.count > 3) {
                logAction(`🚨 **Eliminación masiva de canales detectada.**`);
            }
        } else {
            data.count = 1;
        }
        data.lastTime = Date.now();
        deletionTracker.set(userId, data);
    }
    logAction(`🛑 **Canal eliminado: ${channel.name}**`);
});

client.on('roleCreate', async (role) => {
    logAction(`🔧 **Nuevo rol creado: ${role.name}**`);
});

client.on('roleDelete', async (role) => {
    let userId = role.guild.ownerId;
    if (!roleDeletionTracker.has(userId)) roleDeletionTracker.set(userId, { count: 1, lastTime: Date.now() });
    else {
        let data = roleDeletionTracker.get(userId);
        let timeDiff = Date.now() - data.lastTime;
        if (timeDiff < 10000) {
            data.count++;
            if (data.count > 3) {
                logAction(`🚨 **Eliminación masiva de roles detectada.**`);
            }
        } else {
            data.count = 1;
        }
        data.lastTime = Date.now();
        roleDeletionTracker.set(userId, data);
    }
    logAction(`🛑 **Un rol ha sido eliminado: ${role.name}**`);
});

client.on('messageDelete', async (message) => {
    if (message.partial) return;
    logAction(`🗑️ **Mensaje eliminado en ${message.channel}:** "${message.content}"`);
});

// Función para registrar la acción en el canal de logs
function logAction(content) {
    const logsChannel = client.channels.cache.get(logsChannelId);
    if (!logsChannel) return;
    const embed = new EmbedBuilder()
        .setColor('Red')
        .setDescription(content)
        .setTimestamp();
    logsChannel.send({ embeds: [embed] });
}

// Comando Slash para cambiar el canal de logs
client.on('ready', () => {
    const commands = [
        new SlashCommandBuilder()
            .setName('setlogs')
            .setDescription('Cambia el canal de logs.')
            .addChannelOption(option =>
                option.setName('canal')
                    .setDescription('Selecciona el canal de logs')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText)) // Usando ChannelType.GuildText
    ];

    client.application.commands.set(commands);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'setlogs') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: '¡No tienes permisos para cambiar el canal de logs!', ephemeral: true });
        }

        const newChannel = interaction.options.getChannel('canal');

        if (!newChannel || newChannel.type !== ChannelType.GuildText) {
            // Usamos deferReply para indicar que estamos procesando la solicitud
            await interaction.deferReply();
            return interaction.editReply({ content: '¡Por favor selecciona un canal de texto válido!', ephemeral: true });
        }

        // Aquí nos aseguramos de que la interacción se ha respondido de manera correcta
        await interaction.deferReply();

        logsChannelId = newChannel.id;
        await interaction.editReply({ content: `¡El canal de logs ha sido cambiado a <#${newChannel.id}>!`, ephemeral: true });
    }
});
client.login('ingrese el token aquí');
