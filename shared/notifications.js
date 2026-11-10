export function notificationText(report) {
  const messages = {
    not_requested: 'Enter a family number and submit to request a WhatsApp notification.',
    pending: 'WhatsApp notification queued. It will send when the sender account is connected.',
    sending: 'Sending the WhatsApp notification…',
    sent: 'Notification sent to WhatsApp. Delivery to the recipient is not yet confirmed.',
    skipped: 'No family phone number provided. No WhatsApp notification requested.',
    disabled: 'WhatsApp notifications were disabled when this report was submitted.',
    not_applicable: 'WhatsApp family notifications apply to Safe reports only.',
    unknown: 'Send result uncertain. Check with the recipient before requesting another message.',
  };
  if (report?.notificationStatus === 'failed') return report.notificationError === 'number_not_registered'
    ? 'The family number is not registered on WhatsApp. Your safety report is saved.'
    : 'WhatsApp notification failed. Your safety report is saved.';
  return messages[report?.notificationStatus] || 'No WhatsApp notification recorded for this report.';
}

export function connectionText(status) {
  if (!status?.enabled) return 'WhatsApp disabled';
  return ({ idle: 'WhatsApp awaiting setup', logging_out: 'WhatsApp logging out', starting: 'WhatsApp connecting', qr_required: 'WhatsApp: scan QR on Super Admin setup page', authenticated: 'WhatsApp finishing connection', ready: 'WhatsApp connected', disconnected: 'WhatsApp disconnected · Super Admin can reconnect', auth_failure: 'WhatsApp: sender login failed', error: 'WhatsApp unavailable · Super Admin can retry connection', stopped: 'WhatsApp stopped' })[status.state] || 'WhatsApp connecting';
}

export function safeConfirmationText(report) {
  const reminder = 'Please keep calm and remain in a safe area.';
  return report?.notificationStatus === 'sent' ? 'Notification sent to WhatsApp. ' + reminder
    : ['skipped', 'disabled', 'not_requested'].includes(report?.notificationStatus) ? reminder
    : notificationText(report) + ' ' + reminder;
}
