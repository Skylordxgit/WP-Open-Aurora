import {
  mapEvolutionHistorySync,
  mapEvolutionEdit,
  mapEvolutionMessage,
  mapEvolutionReaction,
  mapEvolutionReceipt,
  mapEvolutionRevocation,
  toEvolutionWhatsAppId,
  toNeutralWhatsAppId,
} from './evolution-go-message-mapper';

describe('Evolution Go message mapper', () => {
  it('normalizes direct, device, group, and privacy ids at the engine boundary', () => {
    expect(toNeutralWhatsAppId('15551234567:19@s.whatsapp.net')).toBe('15551234567@c.us');
    expect(toNeutralWhatsAppId('120363000000@g.us')).toBe('120363000000@g.us');
    expect(toNeutralWhatsAppId('998877@lid')).toBe('998877@lid');
    expect(toEvolutionWhatsAppId('15551234567@c.us')).toBe('15551234567@s.whatsapp.net');
  });

  it('maps a LID-backed inbound media reply to the resolvable phone conversation', () => {
    const mapped = mapEvolutionMessage(
      {
        event: 'Message',
        data: {
          Info: {
            ID: 'MSG-1',
            Chat: '998877@lid',
            Sender: '998877@lid',
            SenderAlt: '15551234567@s.whatsapp.net',
            Timestamp: '2026-08-22T12:00:00Z',
            IsFromMe: false,
            PushName: 'Ada',
          },
          Message: {
            imageMessage: {
              caption: 'receipt',
              mimetype: 'image/jpeg',
              fileName: 'receipt.jpg',
              contextInfo: {
                stanzaId: 'OLD-1',
                quotedMessage: { conversation: 'Please send it' },
              },
            },
            base64: 'aW1hZ2U=',
          },
        },
      },
      '15550000000:2@s.whatsapp.net',
    );

    expect(mapped).toMatchObject({
      id: 'MSG-1',
      chatId: '998877@lid',
      from: '15551234567@c.us',
      to: '15550000000@c.us',
      body: 'receipt',
      type: 'image',
      fromMe: false,
      isLidSender: false,
      senderPhone: '15551234567',
      contact: { pushName: 'Ada' },
      media: {
        mimetype: 'image/jpeg',
        filename: 'receipt.jpg',
        data: 'aW1hZ2U=',
      },
      quotedMessage: { id: 'OLD-1', body: 'Please send it' },
    });
  });

  it('maps outgoing group messages and preserves the participant semantics', () => {
    const mapped = mapEvolutionMessage(
      {
        data: {
          Info: {
            ID: 'OUT-1',
            Chat: '120363000000@g.us',
            Sender: '15550000000@s.whatsapp.net',
            Timestamp: 1_777_000_000,
            IsFromMe: true,
            IsGroup: true,
          },
          Message: { conversation: 'hello team' },
        },
      },
      '15550000000@s.whatsapp.net',
    );

    expect(mapped).toMatchObject({
      id: 'OUT-1',
      chatId: '120363000000@g.us',
      from: '15550000000@c.us',
      to: '120363000000@g.us',
      type: 'text',
      body: 'hello team',
      fromMe: true,
      isGroup: true,
    });
  });

  it('maps receipt, reaction, and revocation protocol events', () => {
    expect(mapEvolutionReceipt({ state: 'Delivered', data: { MessageIDs: ['A', 'B'] } })).toEqual({
      ids: ['A', 'B'],
      status: 'delivered',
    });

    expect(
      mapEvolutionReaction({
        data: {
          Info: { ID: 'REACTION-EVENT', Chat: '1555@s.whatsapp.net', Sender: '1555@s.whatsapp.net' },
          Message: { reactionMessage: { key: { ID: 'TARGET' }, text: 'ok' } },
        },
      }),
    ).toMatchObject({ messageId: 'TARGET', chatId: '1555@c.us', reaction: 'ok', senderId: '1555@c.us' });

    expect(
      mapEvolutionRevocation({
        data: {
          Info: { Chat: '1555@s.whatsapp.net', Sender: '1555@s.whatsapp.net', Timestamp: 1_777_000_001 },
          Message: { protocolMessage: { type: 'REVOKE', key: { ID: 'TARGET' } } },
        },
      }),
    ).toMatchObject({ id: 'TARGET', chatId: '1555@c.us', type: 'revoked', body: '' });

    expect(
      mapEvolutionEdit({
        data: {
          Info: { Chat: '1555@s.whatsapp.net', Timestamp: 1_777_000_002 },
          Message: {
            protocolMessage: {
              type: 'MESSAGE_EDIT',
              key: { ID: 'TARGET' },
              editedMessage: { extendedTextMessage: { text: 'corrected text' } },
            },
          },
        },
      }),
    ).toMatchObject({ messageId: 'TARGET', chatId: '1555@c.us', body: 'corrected text', type: 'text' });
  });

  it('flattens and de-duplicates HistorySync conversations in timestamp order', () => {
    const event = {
      event: 'HistorySync',
      data: {
        Data: {
          Conversations: [
            {
              ID: '1555@s.whatsapp.net',
              Messages: [
                {
                  Message: {
                    Info: {
                      ID: 'B',
                      Chat: '1555@s.whatsapp.net',
                      Sender: '1555@s.whatsapp.net',
                      Timestamp: 200,
                    },
                    Message: { conversation: 'second' },
                  },
                },
                {
                  Message: {
                    Info: {
                      ID: 'A',
                      Chat: '1555@s.whatsapp.net',
                      Sender: '1555@s.whatsapp.net',
                      Timestamp: 100,
                    },
                    Message: { conversation: 'first' },
                  },
                },
                {
                  Message: {
                    Info: { ID: 'A', Chat: '1555@s.whatsapp.net', Sender: '1555@s.whatsapp.net' },
                    Message: { conversation: 'duplicate' },
                  },
                },
              ],
            },
          ],
        },
      },
    };

    expect(mapEvolutionHistorySync(event, '9999@s.whatsapp.net').map(message => message.id)).toEqual(['A', 'B']);
  });
});
