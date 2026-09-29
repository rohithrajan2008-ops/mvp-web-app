import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "data", "db.json");
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-before-production";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "100kb" }));

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar || "",
    status: user.status || "Available"
  };
}
function sign(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session." });
  }
}
function contactKey(a, b) {
  return [a, b].sort().join(":");
}
function areContacts(db, a, b) {
  const key = contactKey(a, b);
  return db.contacts.some(c => c.key === key);
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const displayName = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3-24 characters using letters, numbers, or underscore." });
  }
  if (displayName.length < 2 || displayName.length > 40) {
    return res.status(400).json({ error: "Display name must be 2-40 characters." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const db = readDb();
  if (db.users.some(u => u.username === username)) {
    return res.status(409).json({ error: "Username already exists." });
  }

  const user = {
    id: crypto.randomUUID(),
    username,
    displayName,
    passwordHash: await bcrypt.hash(password, 12),
    avatar: "",
    status: "Available",
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeDb(db);

  res.status(201).json({ token: sign(user), user: publicUser(user) });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const db = readDb();
  const user = db.users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get("/api/me", auth, (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.id === req.user.sub);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json(publicUser(user));
});

app.get("/api/users/suggestions", auth, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const db = readDb();
  const mine = req.user.sub;
  const results = db.users
    .filter(u => u.id !== mine)
    .filter(u => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q))
    .filter(u => !areContacts(db, mine, u.id))
    .slice(0, 12)
    .map(publicUser);
  res.json(results);
});

app.get("/api/contacts", auth, (req, res) => {
  const db = readDb();
  const mine = req.user.sub;
  const ids = db.contacts
    .filter(c => c.a === mine || c.b === mine)
    .map(c => c.a === mine ? c.b : c.a);
  res.json(db.users.filter(u => ids.includes(u.id)).map(publicUser));
});

app.post("/api/contacts/:userId", auth, (req, res) => {
  const db = readDb();
  const mine = req.user.sub;
  const other = req.params.userId;
  if (mine === other) return res.status(400).json({ error: "You cannot add yourself." });
  const target = db.users.find(u => u.id === other);
  if (!target) return res.status(404).json({ error: "User not found." });

  const key = contactKey(mine, other);
  if (!db.contacts.some(c => c.key === key)) {
    db.contacts.push({
      id: crypto.randomUUID(),
      key,
      a: mine,
      b: other,
      createdAt: new Date().toISOString()
    });
    writeDb(db);
  }
  res.status(201).json(publicUser(target));
});

app.get("/api/messages/:userId", auth, (req, res) => {
  const db = readDb();
  const mine = req.user.sub;
  const other = req.params.userId;
  if (!areContacts(db, mine, other)) {
    return res.status(403).json({ error: "This user is not in your contacts." });
  }
  const messages = db.messages
    .filter(m => (m.from === mine && m.to === other) || (m.from === other && m.to === mine))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-500);
  res.json(messages);
});

const online = new Map();

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", socket => {
  const userId = socket.user.sub;
  online.set(userId, socket.id);
  io.emit("presence", { userId, online: true });

  socket.on("send-message", ({ to, text }, callback) => {
    try {
      const clean = String(text || "").trim().slice(0, 3000);
      const db = readDb();
      if (!clean) return callback?.({ ok: false, error: "Message is empty." });
      if (!areContacts(db, userId, to)) return callback?.({ ok: false, error: "Not a contact." });

      const message = {
        id: crypto.randomUUID(),
        from: userId,
        to,
        text: clean,
        createdAt: new Date().toISOString(),
        readAt: null
      };
      db.messages.push(message);
      writeDb(db);

      socket.emit("message", message);
      const targetSocket = online.get(to);
      if (targetSocket) io.to(targetSocket).emit("message", message);
      callback?.({ ok: true, message });
    } catch {
      callback?.({ ok: false, error: "Unable to send message." });
    }
  });

  socket.on("typing", ({ to, isTyping }) => {
    const targetSocket = online.get(to);
    if (targetSocket) io.to(targetSocket).emit("typing", { from: userId, isTyping: !!isTyping });
  });

  socket.on("mark-read", ({ withUser }) => {
    const db = readDb();
    const now = new Date().toISOString();
    let changed = false;
    db.messages.forEach(m => {
      if (m.from === withUser && m.to === userId && !m.readAt) {
        m.readAt = now;
        changed = true;
      }
    });
    if (changed) writeDb(db);
    const targetSocket = online.get(withUser);
    if (targetSocket) io.to(targetSocket).emit("read-receipt", { by: userId, at: now });
  });

  socket.on("call-user", ({ to, offer, video }) => {
    const targetSocket = online.get(to);
    if (!targetSocket) return socket.emit("call-unavailable", { to });
    io.to(targetSocket).emit("incoming-call", { from: userId, offer, video: !!video });
  });

  socket.on("answer-call", ({ to, answer }) => {
    const targetSocket = online.get(to);
    if (targetSocket) io.to(targetSocket).emit("call-answered", { from: userId, answer });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    const targetSocket = online.get(to);
    if (targetSocket) io.to(targetSocket).emit("ice-candidate", { from: userId, candidate });
  });

  socket.on("reject-call", ({ to }) => {
    const targetSocket = online.get(to);
    if (targetSocket) io.to(targetSocket).emit("call-rejected", { from: userId });
  });

  socket.on("end-call", ({ to }) => {
    const targetSocket = online.get(to);
    if (targetSocket) io.to(targetSocket).emit("call-ended", { from: userId });
  });

  socket.on("disconnect", () => {
    if (online.get(userId) === socket.id) online.delete(userId);
    io.emit("presence", { userId, online: false });
  });
});

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) return next();
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
