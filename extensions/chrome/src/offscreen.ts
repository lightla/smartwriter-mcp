// Offscreen document for MediaRecorder-based video recording
// Receives PNG frames from background, draws them on canvas, encodes to webm

const canvas = document.getElementById('recording-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let isRecording = false;
let lastFrameTime = 0;
const FPS = 10;
const FRAME_INTERVAL = 1000 / FPS;
let animFrameId = 0;

// Draw a frame on canvas from base64 PNG data
function drawFrame(base64Data: string): void {
  const img = new Image();
  img.onload = () => {
    canvas.width = img.naturalWidth || 1280;
    canvas.height = img.naturalHeight || 720;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
  };
  img.src = `data:image/png;base64,${base64Data}`;
}

// Start recording the canvas stream
function startRecording(): void {
  if (isRecording) return;
  chunks = [];

  const stream = canvas.captureStream(FPS);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 1000000, // 1 Mbps
  });

  mediaRecorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  mediaRecorder.start(1000); // emit data every 1 second
  isRecording = true;
}

// Stop recording and return webm blob
async function stopRecording(): Promise<string> {
  return new Promise((resolve) => {
    if (!mediaRecorder || !isRecording) {
      resolve('');
      return;
    }

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const reader = new FileReader();
      reader.onloadend = () => {
        // Return base64 encoded webm (strip data:video/webm;base64, prefix)
        const base64 = reader.result as string;
        resolve(base64.split(',')[1] || '');
      };
      reader.readAsDataURL(blob);
      isRecording = false;
      mediaRecorder = null;
    };

    mediaRecorder.stop();
  });
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_DRAW_FRAME') {
    drawFrame(message.data);
    sendResponse({ ok: true });
  } else if (message.type === 'OFFSCREEN_START_RECORDING') {
    startRecording();
    sendResponse({ ok: true });
  } else if (message.type === 'OFFSCREEN_STOP_RECORDING') {
    stopRecording().then((base64) => {
      sendResponse({ webm: base64 });
    });
    return true; // Keep channel open for async response
  }
  return false;
});