const express = require("express");
const volleyball = require("volleyball");
const pathlib = require("path");
const fs = require("fs").promises;
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const { spawn } = require("child_process");

const app = express();

app.use(volleyball);

const makeProbe = async (path) => {
  try {
    const { stdout } = await exec(
      `ffprobe  -select_streams v -show_frames -print_format json -show_entries frames ${path}`,
      { maxBuffer: 1024 * 1024 * 10 }
    );
    return stdout;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
};

async function ensureFrameData(videoFilePath) {
  jsonPath = videoFilePath + ".json";
  try {
    await fs.stat(jsonPath);
  } catch (error) {
    await fs.writeFile(jsonPath, await makeProbe(videoFilePath));
  }
  return JSON.parse(await fs.readFile(jsonPath, "utf-8"));
}

app.get("/videos/:videoName", async (req, res, next) => {
  const videoFilePath = pathlib.join(__dirname, "videos", req.params.videoName);
  try {
    await fs.stat(videoFilePath);
    const { frames } = await ensureFrameData(videoFilePath);
    const keyframes = frames.filter((frame) => frame.pict_type === "I");

    res.json(keyframes);
  } catch (error) {
    return next(error);
  }
});

app.get("/videos/:videoName/group-of-pictures", async (req, res, next) => {
  const videoFilePath = pathlib.join(__dirname, "videos", req.params.videoName);
  try {
    await fs.stat(videoFilePath);
    const { frames } = await ensureFrameData(videoFilePath);
    const keyframes = frames.filter((frame) => frame.pict_type === "I");
    let html = [`<div style="display: flex; flex-wrap: wrap;">`];

    for (let i = 0; i < keyframes.length; i++) {
      let [from, to] = [keyframes[i], keyframes[i + 1]];
      if (to) {
        const fromTime = Number(from.best_effort_timestamp_time).toFixed(2);
        const toTime = Number(to.best_effort_timestamp_time).toFixed(2);
        html.push(`
          <div style="display: flex; flex-direction: column; padding: .4rem; margin: .2rem; border: 1px solid;">
            <video
              controls
              width="200"
              src="/videos/${req.params.videoName}/group-of-pictures/${i}.mp4${
                req.query.crop ? `?crop=${req.query.crop}` : ""
              }"
            >
            </video>
            <code>Group: ${i} (${fromTime} - ${toTime})</code>
          </div>
        `);
      }
    }
    html.push("</div>");
    res.send(html.join("\n"));
  } catch (error) {
    next(error);
  }
});

app.get(
  "/videos/:videoName/group-of-pictures/:group.mp4",
  async (req, res, next) => {
    const videoFilePath = pathlib.join(
      __dirname,
      "videos",
      req.params.videoName
    );
    try {
      await fs.stat(videoFilePath);
      const { frames } = await ensureFrameData(videoFilePath);
      const keyframes = frames.filter((frame) => frame.pict_type === "I");

      const [from, to] = [
        keyframes[+req.params.group],
        keyframes[+req.params.group + 1],
      ];

      if (!(from && to)) {
        return res.sendStatus(404);
      }

      const fromTime = from.best_effort_timestamp_time;
      const toTime = to.best_effort_timestamp_time;
      const splitter = spawn("ffmpeg", [
        "-ss",
        fromTime,
        "-to",
        toTime,
        "-i",
        videoFilePath,
        "-g",
        300,
        ...(req.query.crop
          ? ["-filter:v", `crop=${req.query.crop}`]
          : ["-vcodec", "copy"]),
        "-acodec",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "-async",
        "1",
        "pipe:1",
      ]);
      console.log(splitter.spawnargs);
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        Connection: "Keep-Alive",
        "Content-Type": "video/mp4",
      });
      splitter.stdout.pipe(res);

      res.on("close", () => {
        splitter.kill("SIGKILL");
      });
      // error logging
      splitter.stderr.setEncoding("utf8");
      splitter.stderr.on("data", (data) => {
        console.log(data);
      });
    } catch (error) {
      return next(error);
    }
  }
);

app.listen(4444, (error) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log("Serving groups of pictures at localhost:4444");
});
