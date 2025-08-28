// main.js
let recorder = null;
let combinedStream = null;
let screenStream = null;
let micStream = null;

const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const preview  = document.getElementById('preview');

function setStatus(text) {
  statusEl.textContent = text || '';
}

function bestMimeType() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const candidates = isIOS ? 
    ['video/mp4'] : // Use MP4 for iOS
    [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
  
  for (const t of candidates) {
    if (MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return 'video/webm';
}

async function startRecording() {
  try {
    setStatus('Spør etter tilatelser');

    // 1) Ask user to pick a screen/window/tab (video only).
    //    audio:false so we DO NOT capture system/tab audio. (Mic will come from getUserMedia.)
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    });

    // 2) Ask for microphone (audio only, no webcam video).
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      },
      video: false
    });

    // 3) Combine the single screen video track with the microphone audio track.
    const tracks = [
      screenStream.getVideoTracks()[0],
      micStream.getAudioTracks()[0]
    ].filter(Boolean);

    combinedStream = new MediaStream(tracks);

    // Show a live preview of what we're recording (muted to prevent echo).
    preview.srcObject = combinedStream;
    preview.muted = true;

    // 4) Configure and start RecordRTC.
    const mimeType = bestMimeType();
    recorder = new RecordRTCPromisesHandler(combinedStream, {
      type: 'video',
      mimeType,
      disableLogs: true,
      bitsPerSecond: 4_000_000 // tweak as needed (quality vs. size)
    });

    await recorder.startRecording();
    setStatus('Tar opp innspillingen');
    startBtn.disabled = true;
    stopBtn.disabled = false;

    // If the user stops sharing the screen from the browser UI, stop recording gracefully.
    const vTrack = screenStream.getVideoTracks()[0];
    if (vTrack) {
      vTrack.onended = () => {
        if (!stopBtn.disabled) stopRecording();
      };
    }
  } catch (err) {
    console.error(err);
    setStatus(`Feilmelding: ${err.message}`);
    cleanup();
  }
}

async function stopRecording() {
  try {
    setStatus('Stopper');
    stopBtn.disabled = true;

    if (recorder) {
      await recorder.stopRecording();
      const blob = await recorder.getBlob();
      const fileName = `screen-mic-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;

      // Save to disk
      RecordRTC.invokeSaveAsDialog(blob, fileName);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Feilmelding mens den stoppet: ${err.message}`);
  } finally {
    cleanup();
    setStatus('Lagret.');
  }
}

function cleanup() {
  startBtn.disabled = false;
  stopBtn.disabled = true;

  // Stop tracks and clear objects
  [screenStream, micStream, combinedStream].forEach(stream => {
    if (stream) stream.getTracks().forEach(t => t.stop());
  });

  // Release the preview
  if (preview.srcObject) {
    preview.srcObject = null;
  }

  recorder = null;
  screenStream = null;
  micStream = null;
  combinedStream = null;
}

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
