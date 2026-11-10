import { createWhatsAppTransport } from './whatsapp.js';
import { familyPhone } from './notifications.js';

// Optional recipient argument explicitly requests one test message. Running
// without an argument only links/checks the sender, without messaging anyone.
let recipient;
try { if (process.argv[2]) recipient = familyPhone(process.argv[2]); }
catch (error) { console.error(error.message);process.exit(1); }
const transport = createWhatsAppTransport({ terminalQR: true });
let attempted = false;
transport.onChange(() => {
  if (transport.status().state !== 'ready' || attempted) return;
  attempted = true;
  if (!recipient) { console.log('Sender connection verified. No test message was requested. Press Control+C before starting server.js.');return; }
  void (async () => {
    try {
      const contact = await transport.lookup(recipient.replace(/^\+/, ''));
      if (!contact) { console.error('The recipient number is not registered on WhatsApp.');return; }
      await transport.send(contact, 'Auto Safety Report System\nThis is an FYP notification test. No actual emergency is being reported.\n此為畢業專題測試通知，並非真實事故。');
      console.log('One test message submitted to WhatsApp. Check the recipient phone; this does not confirm delivery.');
    } catch { console.error('Test send result uncertain. Check the recipient before running another test.'); }
  })();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await transport.stop();process.exit(0); });
await transport.start();
if (transport.status().state === 'error') { await transport.stop();process.exitCode = 1; }
