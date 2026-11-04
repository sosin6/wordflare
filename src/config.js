// Central configuration. Change values here only.
export const CONFIG = {
  SITE_URL: 'https://wordflare.app',
  // Umami Cloud website ID (Settings → Websites → Edit → Website ID). Empty = analytics off.
  UMAMI_WEBSITE_ID: '22ad8ccc-1b77-4086-b5c5-e71141a3da95',
  // Google Apps Script web-app URL that appends waitlist emails to a Google Sheet. Empty = email form hidden.
  LEADS_ENDPOINT: 'https://script.google.com/macros/s/AKfycbyAmKynM_ecRiDKT0fRyRioDDcgFk9kiREOQcn9Swh8ely8YpRg1sQVgGNTjsPtUDqSEQ/exec',
  // Free plan limits
  MAX_SECONDS: 180,
  // Whisper model (word timestamps). Runs fully in the browser.
  MODEL_ID: 'onnx-community/whisper-base_timestamped',
  TRANSFORMERS_URL: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3',
  CONTACT_EMAIL: 'wordflare.app@gmail.com',
  INSTAGRAM: 'https://www.instagram.com/wordflare.app/',
  X: 'https://x.com/wordflare_app',
};
