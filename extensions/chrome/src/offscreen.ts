// Offscreen document for MediaRecorder-based video recording
// Receives PNG frames from background, draws them on canvas, encodes to webm

const canvas = document.getElementById('recording-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Pre-size canvas to 1280x720 so captureStream starts with correct dimensions
canvas.width = 1280;
canvas.height = 720;
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, canvas.width, canvas.height);

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let isRecording = false;

// Frame queue to prevent race conditions
let pendingFrames: string[] = [];
let isDrawing = false;

// Draw a frame on canvas from base64 PNG data (sequential queue)
function drawFrame(base64Data: string): void {
  pendingFrames.push(base64Data);
  if (!isDrawing) processNextFrame();
}

function processNextFrame(): void {
  if (isDrawing || pendingFrames.length === 0) return;
  isDrawing = true;

  const base64Data = pendingFrames.shift()!;

  // Drop frames if queue is too large (keep up with real-time)
  while (pendingFrames.length > 3) {
    pendingFrames.shift();
  }

  const img = new Image();
  img.onload = () => {
    canvas.width = img.naturalWidth || 1280;
    canvas.height = img.naturalHeight || 720;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
    isDrawing = false;
    if (pendingFrames.length > 0) {
      processNextFrame();
    }
  };
  img.onerror = () => {
    isDrawing = false;
    if (pendingFrames.length > 0) {
      processNextFrame();
    }
  };
  img.src = `data:image/png;base64,${base64Data}`;
}

// Start recording the canvas stream
function startRecording(): void {
  if (isRecording) return;
  chunks = [];
  pendingFrames = [];
  isDrawing = false;

  const stream = canvas.captureStream(10);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2500000, // 2.5 Mbps for better quality
  });

  mediaRecorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  mediaRecorder.start(500); // emit data every 500ms for smoother video
  isRecording = true;
}

// Stop recording and return webm blob
async function stopRecording(): Promise<string> {
  return new Promise((resolve) => {
    if (!mediaRecorder || !isRecording) {
      resolve('');
      return;
    }

    // Wait a brief moment to ensure last frame is drawn
    setTimeout(() => {
      mediaRecorder!.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result as string;
          resolve(base64.split(',')[1] || '');
        };
        reader.readAsDataURL(blob);
        isRecording = false;
        mediaRecorder = null;
      };

      mediaRecorder!.stop();
    }, 300);
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