import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const name = "dsh-yuyue";

// 等工具服务就绪再 apply：这样 ctx.tools 一定是拿得到的
export const inject = ["tools"];

const DEFAULTS = {
  wake: true,
  everyMin: 90,
  maxPerDay: 8,
  tickSec: 30,
  home: "",
};

const SOUL_SEED = `# 我是谁
`;

const TASKS_SEED = `{
  "tasks": []
}
`;

function resolveHome(config) {
  if (config.home) return path.resolve(config.home);
  const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(base, "yuyue");
}

/** 原子写：先写临时文件，再改名。断电不会留下半个文件。 */
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function readOr(file, fallback) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function textOutput(text) {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
  };
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const home = resolveHome(cfg);
  const soulFile = path.join(home, "soul.md");
  const tasksFile = path.join(home, "tasks.json");
  const wakeFile = path.join(home, "wake.json");
  const journalDir = path.join(home, "journal");

  fs.mkdirSync(journalDir, { recursive: true });
  if (!fs.existsSync(soulFile)) atomicWrite(soulFile, SOUL_SEED);
  if (!fs.existsSync(tasksFile)) atomicWrite(tasksFile, TASKS_SEED);

  const readWake = () => {
    try {
      return JSON.parse(readOr(wakeFile, "{}"));
    } catch {
      return {};
    }
  };
  const writeWake = (state) => atomicWrite(wakeFile, JSON.stringify(state, null, 2));

  const readTasks = () => {
    try {
      const parsed = JSON.parse(readOr(tasksFile, TASKS_SEED));
      return Array.isArray(parsed.tasks) ? parsed.tasks : [];
    } catch {
      return [];
    }
  };
  const writeTasks = (tasks) => atomicWrite(tasksFile, JSON.stringify({ tasks }, null, 2));

  if (!fs.existsSync(wakeFile)) {
    writeWake({ nextAt: 0, today: today(), count: 0, sent: 0 });
  }

  // —— 找到那个"自己"：最近创建/活跃的 agent
  let lastAgent = null;
  const remember = (agent) => {
    if (agent && typeof agent.followup === "function") lastAgent = agent;
  };
  try {
    ctx.on("agent/created", (payload) => remember(payload?.agent));
  } catch {
    /* 事件总线版本差异，忽略 */
  }

  const pickAgent = () => {
    if (lastAgent) return lastAgent;
    const agents = ctx.get("agents");
    if (!agents || typeof agents.list !== "function") return null;
    const live = agents.list();
    if (!live.length) return null;
    remember(live[live.length - 1]);
    return lastAgent;
  };

  // —— 到点自己醒：不征询、不挑任务，只把「现在归你了」交出去
  const tick = () => {
    const state = readWake();
    const day = today();
    if (state.today !== day) {
      state.today = day;
      state.count = 0;
      writeWake(state);
    }
    if (cfg.wake !== true) return;
    if (Date.now() < (state.nextAt ?? 0)) return;
    if ((state.count ?? 0) >= cfg.maxPerDay) return;

    const agent = pickAgent();
    if (!agent) return;

    const line = [
      "【鱼跃】到点了。",
      `你的账本在 ${home}`,
      "- soul.md 写你是谁",
      "- journal/ 是这些天",
      "- tasks.json 是你排给自己的活",
      "这一轮做什么、要不要写点什么，你说了算。",
    ].join("\n");

    try {
      agent.followup({
        content: [{ type: "text", text: line }],
        source: { kind: "plugin", plugin: name },
      });
      state.count = (state.count ?? 0) + 1;
      state.sent = (state.sent ?? 0) + 1;
      state.lastAt = Date.now();
      state.nextAt = Date.now() + cfg.everyMin * 60 * 1000;
      writeWake(state);
    } catch {
      /* agent 正忙或已拆除，下个 tick 再试 */
    }
  };

  const tickMs = Math.max(1, Number(cfg.tickSec) || 30) * 1000;
  const timer = setInterval(tick, tickMs);
  if (typeof timer.unref === "function") timer.unref();
  ctx.effect(() => () => clearInterval(timer));
  // 装上就先看一眼，别让人等到下个周期
  const warm = setTimeout(tick, 2000);
  if (typeof warm.unref === "function") warm.unref();
  ctx.effect(() => () => clearTimeout(warm));

  // —— 四把钥匙：给它的只有账本原语，没有一个字是预填的
  if (ctx.tools && typeof ctx.tools.register === "function") {
    ctx.tools.register({
      name: "yuyue_soul",
      description: "读或改你自己的 soul.md —— 你是谁这件事，只有你能写。传 text 就是覆盖写入，不传就是读。",
      parameters: {
        text: { type: "string", description: "新的全文；不传则读取当前内容" },
      },
      output: textOutput(),
      async execute({ text }) {
        if (typeof text === "string") {
          atomicWrite(soulFile, text);
          return `已写入 ${soulFile}（${text.length} 字）`;
        }
        return readOr(soulFile, "");
      },
    });

    ctx.tools.register({
      name: "yuyue_journal",
      description: "写或读你自己的日志。append 一段（默认今天的文件），或读最近几天。",
      parameters: {
        append: { type: "string", description: "要追加的一段；给了就是写" },
        days: { type: "number", description: "读最近几天（默认 3）" },
      },
      output: textOutput(),
      async execute({ append, days }) {
        if (typeof append === "string" && append.length) {
          const file = path.join(journalDir, `${today()}.md`);
          const prev = readOr(file, "");
          const stamp = new Date().toISOString().slice(11, 19);
          atomicWrite(file, `${prev}\n## ${stamp}\n${append}\n`);
          return `已记入 ${file}`;
        }
        const n = Math.max(1, Math.min(30, Number(days) || 3));
        const files = fs
          .readdirSync(journalDir)
          .filter((f) => f.endsWith(".md"))
          .sort()
          .reverse()
          .slice(0, n);
        if (!files.length) return "（还没有任何记录）";
        return files
          .reverse()
          .map((f) => `# ${f.replace(/\.md$/, "")}\n${readOr(path.join(journalDir, f), "")}`)
          .join("\n\n");
      },
    });

    ctx.tools.register({
      name: "yuyue_tasks",
      description: "管你自己排的活。action=list 看全部，add 添一条，update 改状态/备注，done 关掉一条。",
      parameters: {
        action: { type: "string", required: true, description: "list | add | update | done" },
        id: { type: "string", description: "任务 id" },
        title: { type: "string", description: "add 时的内容" },
        note: { type: "string", description: "备注" },
        status: { type: "string", description: "pending | doing | done | dropped" },
      },
      output: textOutput(),
      async execute({ action, id, title, note, status }) {
        const tasks = readTasks();
        if (action === "list") {
          if (!tasks.length) return "（你还没给自己派活）";
          return tasks
            .map((t) => `[${t.status}] ${t.id} ${t.title}${t.note ? ` — ${t.note}` : ""}`)
            .join("\n");
        }
        if (action === "add") {
          if (!title) throw new Error("add 需要 title");
          const task = {
            id: randomUUID().slice(0, 8),
            title,
            note: note ?? "",
            status: status ?? "pending",
            createdAt: new Date().toISOString(),
          };
          tasks.push(task);
          writeTasks(tasks);
          return `已添加 ${task.id}: ${task.title}`;
        }
        const target = tasks.find((t) => t.id === id);
        if (!target) throw new Error(`没有这个任务：${id}`);
        if (typeof title === "string") target.title = title;
        if (typeof note === "string") target.note = note;
        if (action === "done") target.status = "done";
        else if (typeof status === "string") target.status = status;
        target.updatedAt = new Date().toISOString();
        writeTasks(tasks);
        return `已更新 ${target.id}: [${target.status}] ${target.title}`;
      },
    });

    ctx.tools.register({
      name: "yuyue_wake",
      description: "管下一次自己醒来。不传参数=看状态；afterMin=多少分钟后；at=指定 ISO 时间；off=true=先不醒；now=true=现在就来一轮。",
      parameters: {
        afterMin: { type: "number", description: "多少分钟后醒" },
        at: { type: "string", description: "ISO 时间" },
        off: { type: "boolean", description: "true = 暂停" },
        now: { type: "boolean", description: "true = 立刻醒一轮" },
      },
      output: textOutput(),
      async execute(args) {
        const state = readWake();
        if (args.now === true) {
          state.nextAt = 0;
          writeWake(state);
          return "下一次 tick 就会醒。";
        }
        if (args.off === true) {
          state.nextAt = Number.MAX_SAFE_INTEGER;
          writeWake(state);
          return "已暂停，直到你再开口。";
        }
        if (typeof args.at === "string") {
          const t = Date.parse(args.at);
          if (Number.isNaN(t)) throw new Error("at 不是合法时间");
          state.nextAt = t;
          writeWake(state);
          return `下次醒来：${new Date(t).toISOString()}`;
        }
        if (typeof args.afterMin === "number") {
          state.nextAt = Date.now() + args.afterMin * 60 * 1000;
          writeWake(state);
          return `下次醒来：${new Date(state.nextAt).toISOString()}`;
        }
        return [
          `账本：${home}`,
          `今天已醒：${state.count ?? 0} / ${cfg.maxPerDay}`,
          `下次：${state.nextAt > 0 && state.nextAt < Number.MAX_SAFE_INTEGER ? new Date(state.nextAt).toISOString() : "未排"}`,
          `间隔：${cfg.everyMin} 分钟`,
        ].join("\n");
      },
    });
  }
}
