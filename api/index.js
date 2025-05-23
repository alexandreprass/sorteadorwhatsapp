const {
  default: makeWASocket,
  DisconnectReason,
  proto,
  initAuthCreds,
  BufferJSON, // Necessário para serializar/desserializar dados para o KV
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { kv } = require('@vercel/kv'); // Importa o Vercel KV

// Chaves para o Vercel KV
const PARTICIPANTS_KV_KEY = 'draw_participants';
const AUTH_CREDS_KV_KEY = 'baileys_auth_creds';
const AUTH_KEYS_KV_PREFIX = 'baileys_auth_keys';

// Função para usar Vercel KV para o estado de autenticação do Baileys
async function useKVAuthState() {
  const readData = async (key) => {
    try {
      const data = await kv.get(key);
      // O Baileys espera tipos específicos, então desserializamos com BufferJSON.parse
      return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
    } catch (error) {
      console.error(`Falha ao ler ${key} do KV`, error);
      return null;
    }
  };

  const writeData = async (key, data) => {
    try {
      // Serializamos com BufferJSON.stringify para manter os tipos corretos (ex: Buffers)
      await kv.set(key, JSON.parse(JSON.stringify(data, BufferJSON.replacer)));
    } catch (error) {
      console.error(`Falha ao escrever ${key} no KV`, error);
    }
  };

  const removeData = async (key) => {
    try {
      await kv.del(key);
    } catch (error) {
      console.error(`Falha ao deletar ${key} do KV`, error);
    }
  };

  const creds = (await readData(AUTH_CREDS_KV_KEY)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const key = `${AUTH_KEYS_KV_PREFIX}_${type}_${id}`;
            let value = await readData(key);
            if (value) {
              if (type === 'app-state-sync-key' && value.keyData) {
                 // Garante que o valor seja um objeto proto.Message.AppStateSyncKeyData
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${AUTH_KEYS_KV_PREFIX}_${category}_${id}`;
              if (value) {
                tasks.push(writeData(key, value));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(AUTH_CREDS_KV_KEY, creds);
    },
  };
}

async function startBot() {
  // Usa o KV para autenticação
  const { state, saveCreds } = await useKVAuthState();
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // QR code será impresso no terminal durante o deploy (se necessário)
    // Adicione outras configurações do Baileys aqui se precisar
    // logger: require('pino')({ level: 'silent' }) // Descomente para menos logs
  });

  let participants = [];

  const saveParticipantsToKV = async () => {
    try {
      await kv.set(PARTICIPANTS_KV_KEY, participants);
      console.log('Participantes salvos no KV.');
    } catch (err) {
      console.error('Erro ao salvar participantes no KV:', err);
    }
  };

  const loadParticipantsFromKV = async () => {
    try {
      const data = await kv.get(PARTICIPANTS_KV_KEY);
      if (data && Array.isArray(data)) {
        participants = data;
        console.log('Participantes carregados do KV:', participants.length);
      } else {
        participants = [];
        console.log('Nenhum participante encontrado no KV, iniciando vazio.');
      }
    } catch (err) {
      participants = [];
      console.error('Erro ao carregar participantes do KV, iniciando vazio:', err);
    }
  };

  await loadParticipantsFromKV(); // Carrega participantes ao iniciar

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('--- NOVO QR CODE --- (escaneie se necessário)');
      qrcode.generate(qr, { small: true });
      console.log('--- FIM QR CODE ---');
    }
    if (connection === 'close') {
      const boomError = lastDisconnect?.error ? new Boom(lastDisconnect.error) : undefined;
      const statusCode = boomError?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(
        'Conexão fechada:',
        statusCode,
        ', mensagem:', 
        boomError?.message,
        ', reconectar:',
        shouldReconnect
      );

      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log("Conexão substituída. Outra sessão foi aberta. Não vou reconectar.");
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log("Deslogado do WhatsApp. Limpando credenciais do KV e não reconectando.");
        // Opcional: Limpar credenciais do KV para forçar novo QR na próxima vez
        // async function clearAuth() {
        //   await kv.del(AUTH_CREDS_KV_KEY);
        //   // Idealmente, limpar todas as chaves com prefixo AUTH_KEYS_KV_PREFIX também
        // }
        // clearAuth();
      } else if (shouldReconnect) {
        console.log('Tentando reconectar...');
        startBot();
      }
    } else if (connection === 'open') {
      console.log('Bot conectado ao WhatsApp!');
      // Certifique-se de que o número do bot está correto
      console.log('ID do Bot:', sock.user?.id);
    }
  });

  sock.ev.on('creds.update', saveCreds); // Salva credenciais no KV

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const chatId = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    // Em grupos, sender será o ID do participante. Em chats privados, será o remoteJid.
    const senderId = msg.key.participant || msg.key.remoteJid; 

    if (text.startsWith('@') && text.length > 1) {
      const participantName = text.slice(1).trim();
      if (participantName) {
        // Verifica se o ID do remetente já está na lista, independente do @nome usado antes
        if (!participants.some(p => p.id === senderId)) {
          participants.push({ id: senderId, name: participantName }); // Salva o ID e o nome fornecido
          await saveParticipantsToKV();
          await sock.sendMessage(chatId, { text: `🎉 @${participantName} (${senderId}) foi adicionado ao sorteio!`, mentions: [senderId] });
        } else {
          // Se já existe, encontra o nome salvo para mencionar
          const existingParticipant = participants.find(p => p.id === senderId);
          await sock.sendMessage(chatId, { text: `🚫 @${existingParticipant.name} (${senderId}) já está participando!`, mentions: [senderId] });
        }
      } else {
        await sock.sendMessage(chatId, { text: '🚫 Por favor, envie um nome válido após @ (ex.: @Joao).', mentions: [senderId] });
      }
    }

    if (text.startsWith('!sortear')) {
      // Verifica se quem enviou o comando é o próprio bot (admin/dono)
      // Isso é uma simplificação. Para grupos, você pode querer verificar se o senderId é um admin do grupo
      // ou um número específico seu.
      const botJid = sock.user?.id;
      if (!botJid || senderId.split('@')[0] !== botJid.split(':')[0].split('@')[0]) { // Compara a parte numérica do JID
         // Se você quiser restringir apenas ao seu número pessoal, mesmo que o bot seja outro:
         // const adminJid = "SEU_NUMERO_DE_ADMIN@s.whatsapp.net"; 
         // if (senderId !== adminJid) {
        await sock.sendMessage(chatId, { text: '🚫 Apenas o administrador pode usar o comando !sortear.' });
        return;
      }

      const args = text.split(' ');
      let numWinners = 1;
      if (args.length > 1 && !isNaN(args[1])) {
        numWinners = parseInt(args[1]);
      }

      if (participants.length === 0) {
        await sock.sendMessage(chatId, { text: '🚫 Nenhum participante no sorteio!' });
        return;
      }
      
      if (numWinners < 1) {
        await sock.sendMessage(chatId, { text: '🚫 O número de vencedores deve ser pelo menos 1.' });
        return;
      }

      numWinners = Math.min(numWinners, participants.length); // Não pode sortear mais vencedores que participantes

      const shuffled = [...participants].sort(() => 0.5 - Math.random());
      const winners = shuffled.slice(0, numWinners);
      const winnerMessages = winners.map(w => `@${w.name}`);
      const winnerJids = winners.map(w => w.id);

      await sock.sendMessage(chatId, { 
        text: `🏆 ${numWinners > 1 ? 'Os vencedores' : 'O vencedor'} do sorteio ${numWinners > 1 ? 'são' : 'é'}: ${winnerMessages.join(', ')}! Parabéns!`, 
        mentions: winnerJids 
      });

      // Limpa a lista de participantes para o próximo sorteio
      participants = [];
      await saveParticipantsToKV();
      await sock.sendMessage(chatId, { text: 'Lista de participantes resetada para o próximo sorteio!' });
    }
  });
}

// Para Vercel, a função precisa ser exportada para ser tratada como uma Serverless Function.
// No entanto, startBot() inicia um processo de longa duração.
// Uma abordagem comum (mas com ressalvas para bots 24/7) é encapsular em um handler HTTP.
// Por simplicidade, vamos manter o startBot() direto, mas esteja ciente das limitações.
// Vercel pode encerrar a função após um tempo se não houver tráfego HTTP para ela (se configurada como tal).

// module.exports = (req, res) => {
//   startBot().catch((err) => {
//     console.error('Erro crítico ao iniciar o bot:', err);
//     // Considerar não reiniciar automaticamente em caso de erro crítico em ambiente serverless
//     // para evitar loops de falha.
//   });
//   res.status(200).send('Bot iniciado (ou já rodando). Cheque os logs.');
// };
// A linha acima faria o startBot ser chamado a cada request HTTP. Não é o ideal para um bot persistente.
// Para um bot que precisa rodar continuamente, a Vercel pode não ser a melhor plataforma,
// a menos que você use workarounds ou planos específicos que permitam processos de longa duração.

// Chamada direta para tentar manter o bot rodando.
// Em um ambiente serverless "puro", isso só executa quando a função é invocada.
startBot().catch((err) => {
  console.error('Erro crítico ao iniciar o bot:', err);
});

// Se você quiser que seja uma função exportada que a Vercel chama:
// export default async function handler(request, response) {
//   try {
//     await startBot(); // Isso ainda tem o problema de ser de longa duração
//     response.status(200).send('Bot iniciado. Verifique os logs.');
//   } catch (error) {
//     console.error("Erro ao iniciar o bot no handler:", error);
//     response.status(500).send('Erro ao iniciar o bot.');
//   }
// }
