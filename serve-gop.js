const express = require('express');
const volleyball = require('volleyball');
const pathlib = require('path');
const fs = require('fs').promises;
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { spawn } = require('child_process');


const app = express();

app.use(volleyball);

const makeProbe = async (path) => {
  try {
    const { stdout } = await exec(
      `ffprobe  -select_streams v -show_frames -print_format json -show_entries frames ${path}`,
      { maxBuffer: 1024 * 1024 * 10 }
    )
    return stdout;
  }
  catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

async function ensureFrameData (videoFilePath) {
  jsonPath = videoFilePath + ".json";
  try {
    await fs.stat(jsonPath);
  }
  catch (error) {
    await fs.writeFile(jsonPath, await makeProbe(videoFilePath));
  }
  return JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
}


app.get('/videos/:videoName', async (req, res, next) => {
  const videoFilePath = pathlib.join(__dirname, 'videos', req.params.videoName);
  try {
    await fs.stat(videoFilePath);
    const { frames } = await ensureFrameData(videoFilePath);
    const keyframes = frames.filter(frame => frame.pict_type === "I");

    res.json(keyframes);
  }
  catch (error) {
    return next(error);
  }
});

const blobVideoSource = `
  class BlobVideo extends HTMLVideoElement {
    async connectedCallback () {
      const request = fetch(this.dataset.blobSrc);
      const response = await request;
      const blob = await response.blob();
      const videoURL = URL.createObjectURL(blob);
      this.src = videoURL;

      this.addEventListener('mousemove', this.scrubVideo);
    }

    scrubVideo = (event) => {
      console.count('scrub');
      this.currentTime = this.duration * event.layerX / this.offsetWidth;
      if (this.dataset.projectTo) {
        this.requestVideoFrameCallback(this.projectVideo);
      }
    }

    projectVideo = () => {
      const canvas = document.querySelector(this.dataset.projectTo);
      canvas.width = this.videoWidth;
      canvas.height = this.videoHeight;
      const screen = canvas.getContext('2d');
      screen.drawImage(this, 0, 0, this.videoWidth, this.videoHeight);
    }
  }
  customElements.define('blob-video', BlobVideo, { extends: 'video' });
`;

const videoScreenSource = `
  class VideoScreen extends HTMLVideoElement {
  }
  customElements.define('video-screen', VideoScreen, { extends: 'video' });
`;

const filmStripSource = `
  const css = document.createElement("style");
  css.innerHTML = \`
    film-strip {
      position: relative;
    }

    film-strip-indicator {
      position: absolute;
      height: 100%;
      width: 5px;
      height: 100%;
      top: 0px;
      left: 0px;
      background-color: red;
    }
  \`;

  document.head.appendChild(css);

  class FilmStrip extends HTMLElement {
    connectedCallback () {
      this.indicator = document.createElement("film-strip-indicator");
      this.addEventListener('mousemove', this.setIndicatorPosition);
      this.appendChild(this.indicator);
    }

    setIndicatorPosition = (event) => {
      this.indicator.style.left = \`\${event.target.offsetLeft + event.layerX}px\`;
    }
  }
  customElements.define('film-strip', FilmStrip);
`;

app.get('/videos/:videoName/group-of-pictures', async (req, res, next) => {
  const videoFilePath = pathlib.join(__dirname, 'videos', req.params.videoName);
  try {
    await fs.stat(videoFilePath);
    const { frames } = await ensureFrameData(videoFilePath);
    const keyframes = frames.filter(frame => frame.pict_type === "I");
    let html = [
      '<script>',
      blobVideoSource,
      videoScreenSource,
      filmStripSource,,
      '</script>',
      '<canvas id="preview"></canvas>',
      `<div style="overflow-x: auto">`,
      `<film-strip style="display: flex;">`,
    ];

    for (let i = 0; i < keyframes.length; i++) {
      let [from, to] = [keyframes[i], keyframes[i + 1]];
      if (to) {
        const fromTime = from.best_effort_timestamp_time;
        const toTime = to.best_effort_timestamp_time;
        html.push(`
          <video
            is="blob-video"
            width="200"
            data-project-to="#preview"
            data-blob-src="/videos/${req.params.videoName}/group-of-pictures/${i}.mp4${req.query.crop ? `?crop=${req.query.crop}` : ''}"
          >
          </video>
        `)
      }
    }
    html.push('</film-strip>', '</div>');
    res.send(html.join("\n"));
  }
  catch (error) {
    next(error);
  }
})

app.get('/videos/:videoName/group-of-pictures/:group.mp4', async (req, res, next) => {
  const videoFilePath = pathlib.join(__dirname, 'videos', req.params.videoName);
  try {
    await fs.stat(videoFilePath);
    const { frames } = await ensureFrameData(videoFilePath);
    const keyframes = frames.filter(frame => frame.pict_type === "I");

    const [from, to] = [keyframes[+req.params.group], keyframes[+req.params.group  +1]];

    if (!(from && to)) {
      return res.sendStatus(404);
    }

    const fromTime = from.best_effort_timestamp_time;
    const toTime = to.best_effort_timestamp_time;
    const splitter = spawn('ffmpeg', [
      '-ss', fromTime,
      '-to', toTime,
      '-i', videoFilePath,
      '-g', 300,
      ...(req.query.crop ? ['-filter:v', `crop=${req.query.crop}`] : ['-vcodec', 'copy']),
      '-acodec', 'copy',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      '-async', '1',
      'pipe:1'
    ]);
    console.log(splitter.spawnargs);
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Connection': 'Keep-Alive',
      'Content-Type': 'video/mp4'
    });
    splitter.stdout.pipe(res);

    res.on('close', () => {
      splitter.kill('SIGKILL')
    });
    // error logging
    splitter.stderr.setEncoding('utf8');
    splitter.stderr.on('data', (data) => {
        console.log(data);
    });
  }
  catch (error) {
    return next(error);
  }
});

app.listen(4444, error => {
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log('Serving groups of pictures at localhost:4444');
})
