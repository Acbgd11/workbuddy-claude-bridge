import type { Config } from "./config.ts";

export function renderPage(cfg: Config, apiKey: string): string {
  const endpoint = `http://${cfg.host}:${cfg.port}`;
  const main = cfg.models.map["claude-sonnet"] ?? cfg.models.default;
  const small = cfg.models.map["claude-haiku"] ?? cfg.models.default;

  const rows = [
    { k: "ANTHROPIC_BASE_URL", v: endpoint, secret: false },
    { k: "ANTHROPIC_AUTH_TOKEN", v: apiKey, secret: true },
    { k: "ANTHROPIC_MODEL", v: main, secret: false },
    { k: "ANTHROPIC_DEFAULT_OPUS_MODEL", v: main, secret: false },
    { k: "ANTHROPIC_DEFAULT_SONNET_MODEL", v: main, secret: false },
    { k: "ANTHROPIC_DEFAULT_HAIKU_MODEL", v: small, secret: false },
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy 借给 Claude Code 用</title>
<style>
:root{
  --paper:#F2F4F6; --ink:#141A1F; --muted:#5F6D79; --rule:#D5DCE2;
  --ok:#0F7B5C; --warn:#A96500; --fail:#B3261E;
  --sans:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;
  --serif:"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun",serif;
  --mono:"Cascadia Mono",Consolas,"SF Mono",ui-monospace,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font:16px/1.65 var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:52px 26px 90px}
h1{font-size:21px;font-weight:600;margin:0 0 44px;color:var(--muted)}
h2{font-size:15px;font-weight:600;margin:0 0 6px}
p{margin:0 0 12px}
section{border-top:1px solid var(--rule);padding-top:24px;margin-top:36px}

.line{display:flex;align-items:flex-start;margin:0 0 24px}
.node{flex:none;min-width:132px}
.node.right{text-align:right}
.nm{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;line-height:1.4}
.node.right .nm{flex-direction:row-reverse}
.dot{width:10px;height:10px;border-radius:50%;background:var(--rule);flex:none;
  transition:background .25s ease}
.sub{font-size:13px;color:var(--muted);line-height:1.5;margin-top:3px}
.wire{flex:1;height:2px;background:var(--rule);margin:9px 16px 0;transition:background .25s ease}

.verdict{font-family:var(--serif);font-size:32px;font-weight:600;line-height:1.3;margin:0 0 6px}
.verdict-sub{color:var(--muted);font-size:15px;margin:0}

dl{margin:0}
.row{display:flex;gap:14px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--rule)}
.row .who{font-weight:600;font-size:14.5px;min-width:120px}
.row .what{color:var(--muted);font-size:13.5px;font-family:var(--mono);word-break:break-all}

table{width:100%;border-collapse:collapse}
td{padding:9px 0;border-bottom:1px solid var(--rule);vertical-align:middle}
td.k{font-family:var(--mono);font-size:12.5px;color:var(--muted);
  white-space:nowrap;padding-right:18px;width:1%}
td.v{font-family:var(--mono);font-size:13px;word-break:break-all}
td.a{width:1%;white-space:nowrap;text-align:right;padding-left:12px}

button{font:inherit;font-size:13px;border:1px solid var(--rule);background:#fff;color:var(--ink);
  padding:5px 11px;border-radius:2px;cursor:pointer;transition:border-color .15s ease}
button:hover{border-color:var(--ink)}
button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
button.primary{font-size:14px;padding:9px 18px;border-color:var(--ink);background:var(--ink);color:#fff}
button.primary:hover{background:#000}
button:disabled{opacity:.45;cursor:default}

.note{font-size:13.5px;color:var(--muted)}
.out{margin-top:16px;padding:14px 16px;border-left:2px solid var(--rule);
  background:#fff;font-size:14.5px;white-space:pre-wrap;word-break:break-word}
.out.ok{border-left-color:var(--ok)}
.out.bad{border-left-color:var(--fail)}
.out.busy{border-left-color:var(--warn);color:var(--muted)}
.meta{font-size:12.5px;color:var(--muted);font-family:var(--mono);margin-top:10px}
.hide{display:none}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (max-width:560px){
  .node{min-width:0}
  .nm{font-size:14px}
  .verdict{font-size:26px}
  .row{flex-direction:column;gap:2px}
  .row .who{min-width:0}
  tr{display:block;padding:10px 0;border-bottom:1px solid var(--rule)}
  td{display:block;width:auto;border-bottom:none;padding:0}
  td.k{white-space:normal;padding-right:0}
  td.v{padding:3px 0 7px}
  td.a{text-align:left;padding-left:0}
}
</style>
</head>
<body>
<main>

<h1>WorkBuddy 的积分，借给 Claude Code 用</h1>

<div class="line">
  <div class="node">
    <span class="nm"><i class="dot" id="dotL"></i>WorkBuddy 账号</span>
    <span class="sub" id="accSub">检查中…</span>
  </div>
  <div class="wire" id="wire"></div>
  <div class="node right">
    <span class="nm"><i class="dot" id="dotR"></i>Claude Code</span>
    <span class="sub">经 cc-switch 接入</span>
  </div>
</div>

<p class="verdict" id="verdict">检查中…</p>
<p class="verdict-sub" id="verdictSub"></p>

<section>
  <h2>账号</h2>
  <p class="note" id="accNote"></p>
  <dl id="accList"></dl>
  <p class="hide" id="skipWrap" style="margin:15px 0 0"><button id="skipToggle">看看是哪些文件读不了</button></p>
  <div class="hide" id="skipList"></div>
</section>

<section>
  <h2>填到 cc-switch 里</h2>
  <p class="note">打开 cc-switch → 添加供应商（类型选 Claude）→ 把下面六项抄进去，然后切到这个供应商。</p>
  <table><tbody id="cfgBody"></tbody></table>
  <p style="margin-top:16px"><button id="copyAll">六项一次复制</button></p>
</section>

<section>
  <h2>测一下</h2>
  <p class="note">按下去会真的发一条消息给 WorkBuddy，消耗一点点积分，成功就说明整条链路通了。</p>
  <p><button class="primary" id="testBtn">发一条测试消息</button></p>
  <div id="testOut" class="out hide"></div>
</section>

</main>
<script>
var CFG = ${JSON.stringify(rows)};
var $ = function (id) { return document.getElementById(id); };

function wire(state) {
  var color = state === "ok" ? "var(--ok)" : state === "bad" ? "var(--fail)" : "var(--rule)";
  $("dotL").style.background = color;
  $("dotR").style.background = color;
  $("wire").style.background = color;
}

function say(title, sub, state) {
  $("verdict").textContent = title;
  $("verdictSub").textContent = sub;
  wire(state);
}

function copy(text, btn) {
  var done = function () {
    var old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(function () { btn.textContent = old; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
  } else {
    fallback(text, done);
  }
}

function fallback(text, done) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) {}
  document.body.removeChild(ta);
}

function buildTable() {
  var body = $("cfgBody");
  CFG.forEach(function (row) {
    var tr = document.createElement("tr");

    var k = document.createElement("td");
    k.className = "k";
    k.textContent = row.k;

    var v = document.createElement("td");
    v.className = "v";
    v.textContent = row.secret ? "sk-wb-••••••••••••••••••••" : row.v;
    v.title = row.secret ? "点右边「显示」查看" : row.v;

    var a = document.createElement("td");
    a.className = "a";

    if (row.secret) {
      var show = document.createElement("button");
      show.textContent = "显示";
      show.onclick = function () {
        var hidden = v.textContent.indexOf("•") !== -1;
        v.textContent = hidden ? row.v : "sk-wb-••••••••••••••••••••";
        show.textContent = hidden ? "隐藏" : "显示";
      };
      a.appendChild(show);
      a.appendChild(document.createTextNode(" "));
    }

    var btn = document.createElement("button");
    btn.textContent = "复制";
    btn.onclick = function () { copy(row.v, btn); };
    a.appendChild(btn);

    tr.appendChild(k);
    tr.appendChild(v);
    tr.appendChild(a);
    body.appendChild(tr);
  });
}

function render(s) {
  var n = s.accounts.length;

  if (n === 0) {
    say("还没读到账号", "网关在跑，但没找到能用的 WorkBuddy 登录态。下面「账号」里有原因。", "bad");
  } else {
    say("通了", n + " 个账号可用，把下面的配置填进 cc-switch 就能用。", "ok");
  }

  $("accSub").textContent = n === 0 ? "没读到" : n + " 个可用";

  var list = $("accList");
  list.innerHTML = "";
  s.accounts.forEach(function (a) {
    var row = document.createElement("div");
    row.className = "row";
    var who = document.createElement("span");
    who.className = "who";
    who.textContent = a.label;
    var what = document.createElement("span");
    what.className = "what";
    what.textContent = a.hasRefreshToken ? "可自动续期" : "无续期令牌";
    row.appendChild(who);
    row.appendChild(what);
    list.appendChild(row);
  });
  var skipList = $("skipList");
  skipList.innerHTML = "";
  s.skippedFiles.forEach(function (f) {
    var row = document.createElement("div");
    row.className = "row";
    var who = document.createElement("span");
    who.className = "who";
    who.style.color = "var(--muted)";
    who.style.fontWeight = "400";
    who.textContent = f.path.split("\\\\").pop();
    var what = document.createElement("span");
    what.className = "what";
    what.textContent = f.reason;
    row.appendChild(who);
    row.appendChild(what);
    skipList.appendChild(row);
  });
  $("skipWrap").className = s.skippedFiles.length ? "" : "hide";

  $("accNote").textContent = n === 0
    ? "所有登录态文件都是加密的，读不了。用 WorkBuddy 桌面端登录一次，或在 xdpool 插件卡片里点「添加账号」扫码，就会生成能用的凭据。"
    : "网关直接读你现有的 WorkBuddy 登录态，不需要重新登录。带「无续期令牌」的账号过期后要重新登录一次。";
}

function load() {
  fetch("/healthz")
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () {
      say("连不上网关", "这个页面是从网关本身发出来的，出现这种情况通常是它刚被关掉了。", "bad");
    });
}

$("skipToggle").onclick = function () {
  var box = $("skipList");
  var wasHidden = box.className === "hide";
  box.className = wasHidden ? "" : "hide";
  this.textContent = wasHidden ? "收起来" : "看看是哪些文件读不了";
};

$("copyAll").onclick = function () {
  var text = CFG.map(function (r) { return r.k + "=" + r.v; }).join("\\n");
  copy(text, this);
};

$("testBtn").onclick = function () {
  var btn = this;
  var out = $("testOut");
  btn.disabled = true;
  out.className = "out busy";
  out.textContent = "正在发消息…模型有时候要想十几秒，等一下。";

  fetch("/api/test", { method: "POST" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) {
        out.className = "out ok";
        out.textContent = j.text || "（对方回了空内容，但链路是通的）";
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = j.model + " · " + (j.ms / 1000).toFixed(1) + " 秒";
        out.appendChild(meta);
      } else {
        out.className = "out bad";
        out.textContent = j.reason;
      }
    })
    .catch(function (e) {
      out.className = "out bad";
      out.textContent = "测试没跑起来：" + e;
    })
    .then(function () { btn.disabled = false; });
};

buildTable();
load();
</script>
</body>
</html>`;
}