// ----- INÍCIO DO SCRIPT api/index.js -----
console.log('[BOT_DEBUG] Script api/index.js iniciado.');

const {
  default: makeWASocket,
  DisconnectReason,
  proto,
  initAuthCreds,
  BufferJSON,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { Redis } = require('@upstash/redis');

console.log('[BOT_DEBUG] Módulos importados.');

// Inicializa o cliente Redis
let redis;
try {
  redis = Redis.fromEnv();
  console.log('[BOT_DEBUG] Cliente Upstash Redis inicializado via fromEnv().');
} catch (e) {
  console.error('[BOT_ERROR] Falha ao inicializar cliente Redis fromEnv():', e);
  console.log('[BOT_DEBUG] Verifique se as variáveis de ambiente UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN estão configuradas corretamente na Vercel.');
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[BOT_WARN] Variáveis de ambiente UPSTASH_REDIS_REST_URL e/ou UPSTASH_REDIS_REST_TOKEN não estão definidas!');
  }
}


const PARTICIPANTS_REDIS_KEY = 'draw_participants';
const AUTH_CREDS_REDIS_KEY = 'baileys_auth_creds';
const AUTH_KEYS_REDIS_PREFIX = 'baileys_auth_keys';
console.log('[BOT_DEBUG] Constantes de chaves Redis definidas.');

async function useUpstashAuthState() {
  console.log('[BOT_DEBUG] useUpstashAuthState: Iniciando...');

  const readData = async (key) => {
    console.log(`[BOT_DEBUG] useUpstashAuthState.readData: Lendo chave "${key}"`);
    if (!redis) {
      console.error('[BOT_ERROR] useUpstashAuthState.readData: Cliente Redis não inicializado!');
      return null;
    }
    try {
      const dataString = await redis.get(key);
      if (dataString) {
        console.log(`[BOT_DEBUG] useUpstashAuthState.readData: Dados encontrados para chave "${key}" (tipo: ${typeof dataString})`);
        return JSON.parse(dataString, BufferJSON.reviver);
      }
      console.log(`[BOT_DEBUG] useUpstashAuthState.readData: Nenhum dado para chave "${key}"`);
      return null;
    } catch (error) {
      console.error(`[BOT_ERROR] useUpstashAuthState.readData: Falha ao ler ou parsear ${key}:`, error);
      return null;
    }
  };

  const writeData = async (key, data) => {
    console.log(`[BOT_DEBUG] useUpstashAuthState.writeData: Escrevendo chave "${key}"`);
    if (!redis) {
      console.error('[BOT_ERROR] useUpstashAuthState.writeData: Cliente Redis não inicializado!');
      return;
    }
    try {
      await redis.set(key, JSON.stringify(data, BufferJSON.replacer));
      console.log(`[BOT_DEBUG] useUpstashAuthState.writeData: Chave "${key}" escrita com sucesso.`);
    } catch (error) {
      console.error(`[BOT_ERROR] useUpstashAuthState.writeData: Falha ao escrever ${key}:`, error);
    }
  };

  const removeData = async (key) => {
    console.log(`[BOT_DEBUG] useUpstashAuthState.removeData: Removendo chave "${key}"`);
    if (!redis) {
      console.error('[BOT_ERROR] useUpstashAuthState.removeData: Cliente Redis não inicializado!');
      return;
    }
    try {
      await redis.del(key);
      console.log(`[BOT_DEBUG] useUpstashAuthState.removeData: Chave "${key}" removida com sucesso.`);
    } catch (error) {
      console.error(`[BOT_ERROR] useUpstashAuthState.removeData: Falha ao deletar ${key}:`, error);
    }
  };

  const credsFromDB = await readData(AUTH_CREDS_REDIS_KEY);
  const creds = credsFromDB || initAuthCreds();

  if (credsFromDB) {
    console.log('[BOT_DEBUG] useUpstashAuthState: Credenciais carregadas do DB.');
     if (!creds.processedHistoryMessages) {
        console.log('[BOT_DEBUG] useUpstashAuthState: Credenciais carregadas, mas sem histórico processado (ou campo ausente).');
    } else {
        console.log('[BOT_DEBUG] useUpstashAuthState: Credenciais carregadas com histórico processado.');
    }
  } else {
    console.log('[BOT_DEBUG] useUpstashAuthState: Novas credenciais inicializadas (initAuthCreds), pois não foram encontradas no DB.');
  }
  console.log('[BOT_DEBUG] useUpstashAuthState: Processamento de credenciais concluído.');


  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          console.log(`[BOT_DEBUG] useUpstashAuthState.keys.get: Tipo "${type}", IDs "${ids.join(', ')}"`);
          const data = {};
          for (const id of ids) {
            const key = `${AUTH_KEYS_REDIS_PREFIX}_${type}_${id}`;
            let value = await readData(key);
            if (value) {
              if (type === 'app-state-sync-key' && value.keyData) { 
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          }
          return data;
        },
        set: async (data) => {
          console.log('[BOT_DEBUG] useUpstashAuthState.keys.set: Salvando dados de chaves.');
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${AUTH_KEYS_REDIS_PREFIX}_${category}_${id}`;
              if (value) {
                tasks.push(writeData(key, value));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
          console.log('[BOT_DEBUG] useUpstashAuthState.keys.set: Dados de chaves salvos.');
        },
      },
    },
    saveCreds: async () => {
      console.log('[BOT_DEBUG] useUpstashAuthState.saveCreds: Salvando credenciais principais.');
      await writeData(AUTH_CREDS_REDIS_KEY, creds);
      console.log('[BOT_DEBUG] useUpstashAuthState.saveCreds: Credenciais principais salvas.');
    },
  };
}

async function startBot() {
  console.log('[BOT_DEBUG] startBot: Iniciando função startBot...');
  if (!redis) {
    console.error('[BOT_ERROR] startBot: Cliente Redis não está disponível. Bot não pode iniciar. Verifique as variáveis de ambiente e a inicialização do Redis.');
    return; 
  }

  let state, saveCreds;
  try {
    console.log('[BOT_DEBUG] startBot: Chamando useUpstashAuthState...');
    const authResult = await useUpstashAuthState();
    state = authResult.state;
    saveCreds = authResult.saveCreds;
    console.log('[BOT_DEBUG] startBot: useUpstashAuthState retornado com sucesso.');
  } catch (e) {
    console.error('[BOT_ERROR] startBot: Erro crítico ao chamar useUpstashAuthState:', e);
    return; 
  }

  console.log('[BOT_DEBUG] startBot: Chamando makeWASocket...');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // Baileys ainda pode usar isso, apesar do aviso de depreciação
  });
  console.log('[BOT_DEBUG] startBot: makeWASocket chamado.');

  let participants = [];

  const saveParticipantsToRedis = async () => {
    console.log('[BOT_DEBUG] saveParticipantsToRedis: Salvando participantes...', participants.length > 0 ? participants : 'Lista vazia');
    try {
      await redis.set(PARTICIPANTS_REDIS_KEY, participants);
      console.log('[BOT_DEBUG] saveParticipantsToRedis: Participantes salvos no Redis.');
    } catch (err) {
      console.error('[BOT_ERROR] saveParticipantsToRedis: Erro ao salvar:', err);
    }
  };

  const loadParticipantsFromRedis = async () => {
    console.log('[BOT_DEBUG] loadParticipantsFromRedis: Carregando participantes...');
    try {
      const data = await redis.get(PARTICIPANTS_REDIS_KEY);
      if (data && Array.isArray(data)) {
        participants = data;
        console.log('[BOT_DEBUG] loadParticipantsFromRedis: Participantes carregados:', participants.length);
      } else {
        participants = [];
        console.log('[BOT_DEBUG] loadParticipantsFromRedis: Nenhum participante encontrado ou formato inválido, iniciando vazio.');
      }
    } catch (err) {
      participants = [];
      console.error('[BOT_ERROR] loadParticipantsFromRedis: Erro ao carregar:', err);
    }
  };

  console.log('[BOT_DEBUG] startBot: Carregando participantes iniciais...');
  await loadParticipantsFromRedis();

  sock.ev.on('connection.update', (update) => {
    console.log('[BOT_DEBUG] sock.ev("connection.update"): Evento recebido:', JSON.stringify(update)); // Log do evento completo
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('[BOT_INFO] Novo QR code gerado. Escaneie com seu WhatsApp ou use a string abaixo:');
      console.log('--- INÍCIO DA STRING DO QR CODE ---');
      console.log(qr); // Loga a string original do QR Code
      console.log('--- FIM DA STRING DO QR CODE ---');
      // qrcode-terminal ainda tenta desenhar, apesar do aviso de depreciação do printQRInTerminal
      // Se o printQRInTerminal for totalmente removido do Baileys, esta linha abaixo ainda funcionaria.
      console.log('[BOT_INFO] Tentando desenhar QR Code ASCII:');
      qrcode.generate(qr, { small: true }); 
    }
    if (connection === 'close') {
      const boomError = lastDisconnect?.error ? new Boom(lastDisconnect.error) : undefined;
      const statusCode = boomError?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[BOT_INFO] Conexão fechada. Status: ${statusCode}, Erro: ${boomError?.message}, Reconectar: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log("[BOT_WARN] Conexão substituída. Outra sessão foi aberta. Não tentará reconectar automaticamente esta instância.");
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log("[BOT_WARN] Deslogado do WhatsApp. Não vai reconectar. Limpe as credenciais manualmente no Redis se quiser forçar novo QR na próxima inicialização.");
      } else if (shouldReconnect) {
        console.log('[BOT_INFO] Tentando reconectar chamando startBot() novamente em 5 segundos...');
        setTimeout(startBot, 5000); 
      }
    } else if (connection === 'open') {
      console.log('[BOT_INFO] Bot conectado ao WhatsApp!');
      console.log('[BOT_DEBUG] ID do Bot (sock.user):', sock.user?.id ? sock.user.id : 'Não definido ainda');
    }
  });

  sock.ev.on('creds.update', async () => { 
    console.log('[BOT_DEBUG] sock.ev("creds.update"): Evento recebido. Chamando saveCreds...');
    try {
      await saveCreds(); 
      console.log('[BOT_DEBUG] sock.ev("creds.update"): saveCreds chamado e concluído.');
    } catch (e) {
      console.error('[BOT_ERROR] sock.ev("creds.update"): Erro durante saveCreds:', e);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log('[BOT_DEBUG] sock.ev("messages.upsert"): Evento recebido:', JSON.stringify(messages[0]?.key)); 
    const msg = messages[0];
    if (!msg.message) {
      console.log('[BOT_DEBUG] Mensagem sem conteúdo (msg.message), ignorando.');
      return;
    }
    if (msg.key.fromMe) {
      console.log('[BOT_DEBUG] Mensagem de mim mesmo (fromMe), ignorando.');
      return;
    }

    const chatId = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderId = msg.key.participant || msg.key.remoteJid; 
    console.log(`[BOT_DEBUG] Mensagem recebida: ChatID="${chatId}", SenderID="${senderId}", Texto="${text}"`);

    if (text.startsWith('@') && text.length > 1) {
      const participantName = text.slice(1).trim();
      console.log(`[BOT_DEBUG] Comando @ detectado: Nome="${participantName}"`);
      if (participantName) {
        const existingParticipant = participants.find(p => p.id === senderId);
        if (!existingParticipant) {
          participants.push({ id: senderId, name: participantName });
          await saveParticipantsToRedis();
          console.log(`[BOT_INFO] Participante @${participantName} (${senderId}) adicionado.`);
          try {
            await sock.sendMessage(chatId, { text: `🎉 @${participantName} foi adicionado ao sorteio!`, mentions: [senderId] });
          } catch (e) {
            console.error(`[BOT_ERROR] Falha ao enviar mensagem de confirmação de adição:`, e);
          }
        } else {
          console.log(`[BOT_INFO] Participante @${existingParticipant.name} (${senderId}) já está participando.`);
          try {
            await sock.sendMessage(chatId, { text: `🚫 @${existingParticipant.name} já está participando!`, mentions: [senderId] });
          } catch (e) {
            console.error(`[BOT_ERROR] Falha ao enviar mensagem de participante existente:`, e);
          }
        }
      } else {
        console.log('[BOT_WARN] Comando @ recebido sem nome válido.');
        try {
          await sock.sendMessage(chatId, { text: '🚫 Por favor, envie um nome válido após @ (ex.: @Joao).', mentions: [senderId] });
        } catch (e) {
          console.error(`[BOT_ERROR] Falha ao enviar mensagem de nome inválido:`, e);
        }
      }
    }

    if (text.startsWith('!sortear')) {
      console.log('[BOT_DEBUG] Comando !sortear detectado.');
      const botJid = sock.user?.id;
      console.log(`[BOT_DEBUG] Verificando permissão: SenderID="${senderId}", BotJID="${botJid}"`);
      
      const senderNumericId = senderId.split('@')[0];
      const botNumericId = botJid ? botJid.split(':')[0].split('@')[0] : null;

      if (!botJid || senderNumericId !== botNumericId) {
        console.log('[BOT_WARN] Comando !sortear negado. Permissão insuficiente.');
        try {
          await sock.sendMessage(chatId, { text: '🚫 Apenas o administrador (o próprio bot) pode usar o comando !sortear.' });
        } catch (e) {
          console.error(`[BOT_ERROR] Falha ao enviar mensagem de permissão negada:`, e);
        }
        return;
      }
      console.log('[BOT_DEBUG] Permissão para !sortear concedida.');

      const args = text.split(' ');
      let numWinners = 1;
      if (args.length > 1 && !isNaN(args[1])) {
        numWinners = parseInt(args[1]);
      }
      console.log(`[BOT_DEBUG] Número de vencedores para sortear: ${numWinners}`);

      if (participants.length === 0) {
        console.log('[BOT_INFO] Tentativa de sorteio sem participantes.');
        try {
          await sock.sendMessage(chatId, { text: '🚫 Nenhum participante no sorteio!' });
        } catch (e) {
          console.error(`[BOT_ERROR] Falha ao enviar mensagem de nenhum participante:`, e);
        }
        return;
      }
      
      if (numWinners < 1) {
        console.log('[BOT_WARN] Tentativa de sorteio com número de vencedores < 1.');
        try {
          await sock.sendMessage(chatId, { text: '🚫 O número de vencedores deve ser pelo menos 1.' });
        } catch (e) {
          console.error(`[BOT_ERROR] Falha ao enviar mensagem de vencedores < 1:`, e);
        }
        return;
      }

      numWinners = Math.min(numWinners, participants.length);
      console.log(`[BOT_DEBUG] Número de vencedores ajustado: ${numWinners} (Máx: ${participants.length})`);

      const shuffled = [...participants].sort(() => 0.5 - Math.random());
      const winners = shuffled.slice(0, numWinners);
      const winnerMessages = winners.map(w => `@${w.name}`);
      const winnerJids = winners.map(w => w.id);
      console.log('[BOT_INFO] Vencedores sorteados:', JSON.stringify(winners));

      try {
        await sock.sendMessage(chatId, { 
          text: `🏆 ${numWinners > 1 ? 'Os vencedores' : 'O vencedor'} do sorteio ${numWinners > 1 ? 'são' : 'é'}: ${winnerMessages.join(', ')}! Parabéns!`, 
          mentions: winnerJids 
        });
        console.log('[BOT_INFO] Mensagem de vencedores enviada.');

        participants = [];
        await saveParticipantsToRedis(); 
        console.log('[BOT_INFO] Lista de participantes resetada.');
        await sock.sendMessage(chatId, { text: 'Lista de participantes resetada para o próximo sorteio!' });
      } catch(e) {
        console.error(`[BOT_ERROR] Falha ao enviar mensagens do sorteio ou resetar lista:`, e);
      }
    }
  });
  console.log('[BOT_DEBUG] startBot: Handlers de eventos configurados.');
}

console.log('[BOT_DEBUG] Chamando startBot() automaticamente ao carregar o script...');
startBot().catch((err) => {
  console.error('[BOT_FATAL] Erro crítico não tratado na chamada inicial de startBot():', err);
});

console.log('[BOT_DEBUG] ----- FIM DO SETUP INICIAL DO SCRIPT api/index.js -----');

module.exports = (req, res) => {
  console.log(`[BOT_HANDLER] Requisição HTTP recebida: ${req.method} ${req.url}`);
  console.log('[BOT_HANDLER] O bot tenta iniciar automaticamente quando a função Vercel é carregada.');
  console.log('[BOT_HANDLER] Verifique os logs da função para o QR Code ou status da conexão do bot.');
  
  res.status(200).send('Host do Bot WhatsApp ativo. O bot opera em segundo plano. Verifique os logs da função para status ou QR code.');
};
