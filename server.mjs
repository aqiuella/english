import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const root = fs.existsSync(path.join(baseDir, "public")) ? path.join(baseDir, "public") : baseDir;
const port = Number(process.env.PORT || 4173);
const cache = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8"
};
const requestHeaders = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8"
};

function load(file) {
  const modified = fs.statSync(file).mtimeMs;
  const key = `${file}:${modified}`;
  if (cache.has(key)) return cache.get(key);
  const body = fs.readFileSync(file);
  const type = types[path.extname(file)] || "application/octet-stream";
  const compressible = /^(text\/|application\/(?:json|manifest\+json)|image\/svg)/.test(type);
  const entry = {body, type, gzip: compressible ? zlib.gzipSync(body, {level:9}) : null};
  cache.set(key, entry);
  return entry;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff"
  });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100_000) reject(new Error("请求内容太大"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("请求格式不正确")); }
    });
    req.on("error", reject);
  });
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      redirect:"follow",
      signal:controller.signal,
      headers:{...requestHeaders,...options.headers}
    });
    if (!response.ok) throw new Error(`视频网站返回 ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 8_000_000) throw new Error("字幕文件过大");
    return {text:await response.text(), url:response.url, contentType:response.headers.get("content-type") || ""};
  } catch (error) {
    if (error.name === "AbortError") throw new Error("视频网站响应超时，请稍后重试");
    if (/fetch failed|EACCES|ECONN|ENOTFOUND|ETIMEDOUT/i.test(`${error.message} ${error.cause?.message || ""}`)) {
      throw new Error("服务器暂时无法连接视频网站，请检查网络或稍后再试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&#(\d+);/g,(_,code)=>String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi,(_,code)=>String.fromCodePoint(parseInt(code,16)));
}

function extractBalancedJson(text, start) {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === open) depth++;
    if (char === close && --depth === 0) return text.slice(start,i+1);
  }
  throw new Error("无法解析视频字幕索引");
}

function youtubeId(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0];
    if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2];
    return url.searchParams.get("v");
  } catch { return ""; }
}

async function youtubeTranscript(raw, fallbackTitle) {
  const id = youtubeId(raw);
  if (!id) throw new Error("没有识别出 YouTube 视频 ID");
  const page = await fetchText(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=en`, {
    headers:{"accept-language":"en-US,en;q=0.9"}
  });
  const titleMatch = page.text.match(/<meta\s+name="title"\s+content="([^"]+)"/i);
  const title = decodeEntities(titleMatch?.[1] || fallbackTitle || "YouTube 视频");
  const keyIndex = page.text.indexOf('"captionTracks":');
  if (keyIndex < 0) throw new Error("这个 YouTube 视频没有可读取的字幕轨道");
  const arrayStart = page.text.indexOf("[",keyIndex);
  const tracks = JSON.parse(extractBalancedJson(page.text,arrayStart));
  if (!Array.isArray(tracks) || !tracks.length) throw new Error("这个 YouTube 视频没有字幕");
  const track = tracks.find(item => String(item.languageCode || "").toLowerCase().startsWith("en")) || tracks[0];
  if (!track?.baseUrl) throw new Error("YouTube 没有返回字幕地址");
  const captionUrl = new URL(track.baseUrl);
  captionUrl.searchParams.set("fmt","json3");
  let caption;
  try {
    caption = await fetchText(captionUrl.toString());
    const data = JSON.parse(caption.text);
    const text = (data.events || [])
      .flatMap(event => event.segs || [])
      .map(seg => seg.utf8 || "")
      .join(" ")
      .replace(/\s+/g," ")
      .trim();
    if (text) return {provider:"youtube",title,text};
  } catch {}
  const xml = await fetchText(track.baseUrl);
  const text = [...xml.text.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)]
    .map(match => decodeEntities(match[1]))
    .join(" ")
    .replace(/\s+/g," ")
    .trim();
  if (!text) throw new Error("YouTube 字幕内容为空");
  return {provider:"youtube",title,text};
}

async function bilibiliTranscript(raw, fallbackTitle) {
  const initial = await fetchText(raw, {headers:{referer:"https://www.bilibili.com/"}});
  const finalUrl = initial.url || raw;
  const bvid = finalUrl.match(/\/video\/(BV[0-9A-Za-z]{10})/i)?.[1] || raw.match(/(BV[0-9A-Za-z]{10})/i)?.[1];
  if (!bvid) throw new Error("没有识别出 B 站 BV 号");
  const headers = {referer:`https://www.bilibili.com/video/${bvid}`};
  const view = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,{headers});
  const viewData = await view.json();
  if (!view.ok || viewData.code !== 0) throw new Error(viewData.message || "无法读取 B 站视频信息");
  const info = viewData.data;
  const cid = info.cid;
  const player = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`,{headers});
  const playerData = await player.json();
  const tracks = playerData?.data?.subtitle?.subtitles || [];
  if (!tracks.length) throw new Error("这个 B 站视频没有公开字幕；请复制视频自带 AI 字幕后手动导入");
  const track = tracks.find(item => /^en/i.test(item.lan || "") || /english/i.test(item.lan_doc || "")) || tracks[0];
  const subtitleUrl = track.subtitle_url?.startsWith("//") ? `https:${track.subtitle_url}` : track.subtitle_url;
  if (!subtitleUrl) throw new Error("B 站没有返回字幕地址");
  const subtitles = await fetch(subtitleUrl,{headers:{...requestHeaders,...headers}});
  const data = await subtitles.json();
  const text = (data.body || []).map(item => item.content || "").join(" ").replace(/\s+/g," ").trim();
  if (!text) throw new Error("B 站字幕内容为空");
  return {provider:"bilibili",title:decodeEntities(info.title || fallbackTitle || "B 站视频"),text};
}

export async function generateTranscript({url = "", title = ""}) {
    if (!/^https?:\/\//i.test(url)) {
      const error = new Error("请提供完整的 http(s) 视频网址");
      error.statusCode = 400;
      throw error;
    }
    let result;
    if (/youtube\.com|youtu\.be/i.test(url)) result = await youtubeTranscript(url,title);
    else if (/bilibili\.com|b23\.tv/i.test(url)) result = await bilibiliTranscript(url,title);
    else {
      const error = new Error("目前支持 B 站和 YouTube 视频网址");
      error.statusCode = 400;
      throw error;
    }
    return result;
}

async function handleTranscript(req,res) {
  try {
    const payload = await readJson(req);
    const result = await generateTranscript(payload);
    sendJson(res,200,result);
  } catch (error) {
    sendJson(res,error.statusCode || 422,{error:error.name === "AbortError" ? "视频网站响应超时" : error.message});
  }
}

export async function checkGrammarText(text = "") {
    const clean=String(text||"").trim().slice(0,5000);
    if(!clean) {
      const error = new Error("没有可检查的英文文本");
      error.statusCode = 400;
      throw error;
    }
    const response=await fetch("https://api.languagetool.org/v2/check",{
      method:"POST",
      signal:AbortSignal.timeout(12_000),
      headers:{
        "content-type":"application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent":"SpeakCoach/1.0"
      },
      body:new URLSearchParams({text:clean,language:"en-US",enabledOnly:"false"})
    });
    if(!response.ok)throw new Error(`语法检查服务返回 ${response.status}`);
    const data=await response.json();
    const matches=(data.matches||[]).filter(item=>item.replacements?.length).slice(0,12).map(item=>({
      wrong:clean.slice(item.offset,item.offset+item.length),
      correct:item.replacements[0].value,
      note:item.message,
      confidence:item.rule?.confidence>=0.75?"高":"中",
      rule:item.rule?.id||""
    }));
    return {matches,source:"LanguageTool public API"};
}

async function handleGrammar(req,res) {
  try {
    const {text=""} = await readJson(req);
    const result = await checkGrammarText(text);
    sendJson(res,200,result);
  } catch(error) {
    sendJson(res,error.statusCode || 502,{error:error.name==="TimeoutError"?"语法检查超时":error.message});
  }
}

const appServer = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, "http://localhost");
  if (req.method === "POST" && requestUrl.pathname === "/api/transcript/generate") {
    await handleTranscript(req,res);
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/api/grammar/check") {
    await handleGrammar(req,res);
    return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res,200,{
      ok:true,
      transcriptService:true,
      grammarService:true,
      realtimeChallenge:false,
      networkRequiredForFriends:true
    });
    return;
  }
  const requested = decodeURIComponent(requestUrl.pathname);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const entry = load(file);
    const acceptsGzip = String(req.headers["accept-encoding"] || "").includes("gzip");
    res.writeHead(200, {
      "Content-Type": entry.type,
      "Cache-Control": path.basename(file) === "sw.js" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Encoding": acceptsGzip && entry.gzip ? "gzip" : "identity",
      "Vary": "Accept-Encoding"
    });
    res.end(acceptsGzip && entry.gzip ? entry.gzip : entry.body);
  } catch {
    res.writeHead(404, {"Content-Type": "text/plain; charset=utf-8"}).end("Not found");
  }
});

export { appServer, load as loadStaticFile, root as staticRoot, types as staticTypes };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  appServer.listen(port, "0.0.0.0", () => {
    console.log(`开口 server listening on 0.0.0.0:${port}`);
  });
}
