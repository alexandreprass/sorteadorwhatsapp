const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs').promises;
const qrcode = require('qrcode-terminal'); // Adiciona biblioteca para exibir QR code

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state });

  // Lista para armazenar participantes do sorteio
  let participants = [];

  // Função para salvar participantes em um arquivo
  const saveParticipants = async () => {
    try {
      await fs.writeFile('participants.json', JSON.stringify(participants));
    } catch (err) {
      console.error('Erro ao salvar participantes:', err);
    }
  };

  // Carregar participantes existentes (se houver)
  try {
    const data = await fs.readFile('participants.json');
    participants = JSON.parse(data);
  } catch (err) {
    console.log('Nenhum arquivo de participantes encontrado, iniciando vazio.');
  }

  // Lidar com atualizações de conexão
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('Novo QR code gerado:');
      qrcode.generate(qr, { small: true }); // Exibe o QR code no terminal
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão fechada:', lastDisconnect.error, ', reconectar:', shouldReconnect);
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('Bot conectado ao WhatsApp!');
    }
  });

  // Salvar credenciais quando atualizadas
  sock.ev.on('creds.update', saveCreds);

  // Lidar com mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const chatId = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const sender = msg.key.participant || msg.key.remoteJid;

    // Comando para participar (@nome)
    if (text.startsWith('@') && text.length > 1) {
      const participantName = text.slice(1).trim();
      if (participantName) {
        if (!participants.some(p => p.id === sender && p.name === participantName)) {
          participants.push({ id: sender, name: participantName });
          await saveParticipants();
          await sock.sendMessage(chatId, { text: `🎉 @${participantName} foi adicionado ao sorteio!`, mentions: [sender] });
        } else {
          await sock.sendMessage(chatId, { text: `🚫 @${participantName} já está participando!`, mentions: [sender] });
        }
      } else {
        await sock.sendMessage(chatId, { text: '🚫 Por favor, envie um nome válido após @ (ex.: @Joao).', mentions: [sender] });
      }
    }

    // Comando para sortear (apenas o número do bot)
    if (text.startsWith('!sortear')) {
      const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      if (sender !== botNumber) {
        await sock.sendMessage(chatId, { text: '🚫 Apenas o bot pode usar o comando !sortear.' });
        return;
      }

      const args = text.split(' ');
      let numWinners = 1;
      if (args.length > 1 && !isNaN(args[1])) {
        numWinners = Math.min(parseInt(args[1]), participants.length);
      }

      if (participants.length === 0) {
        await sock.sendMessage(chatId, { text: '🚫 Nenhum participante no sorteio!' });
        return;
      }

      if (numWinners < 1) {
        await sock.sendMessage(chatId, { text: '🚫 O número de vencedores deve ser pelo menos 1.' });
        return;
      }

      const shuffled = participants.sort(() => 0.5 - Math.random());
      const winners = shuffled.slice(0, numWinners);
      const winnerNames = winners.map(w => `@${w.name}`).join(', ');
      const winnerIds = winners.map(w => w.id);

      await sock.sendMessage(chatId, { 
        text: `🏆 ${numWinners > 1 ? 'Os vencedores' : 'O vencedor'} do sorteio ${numWinners > 1 ? 'são' : 'é'}: ${winnerNames}! Parabéns!`, 
        mentions: winnerIds 
      });

      participants = [];
      await saveParticipants();
    }
  });
}

startBot().catch((err) => console.error('Erro ao iniciar o bot:', err));
