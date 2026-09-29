import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import "./styles.css";

const isDev = import.meta.env.DEV;
const API = isDev ? "http://localhost:4000" : "";
const socketUrl = isDev ? "http://localhost:4000" : window.location.origin;

function api(path, token, options = {}) {
  return fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  });
}

function initials(name = "?") {
  return name.split(" ").map(x => x[0]).join("").slice(0, 2).toUpperCase();
}

function App() {
  const [token, setToken] = useState(localStorage.getItem("chat_token") || "");
  const [me, setMe] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState({});
  const [typing, setTyping] = useState({});
  const [socket, setSocket] = useState(null);
  const [view, setView] = useState("chats");
  const [error, setError] = useState("");
  const [incoming, setIncoming] = useState(null);
  const [call, setCall] = useState(null);

  const pcRef = useRef(null);
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  useEffect(() => {
    if (!token) return;
    let currentSocket;

    Promise.all([api("/api/me", token), api("/api/contacts", token)])
      .then(([u, c]) => { setMe(u); setContacts(c); })
      .catch(() => logout());

    const s = io(socketUrl, { auth: { token } });
    currentSocket = s;
    setSocket(s);

    s.on("presence", ({ userId, online: isOn }) => setOnline(prev => ({ ...prev, [userId]: isOn })));
    s.on("typing", ({ from, isTyping }) => setTyping(prev => ({ ...prev, [from]: isTyping })));
    s.on("message", msg => setMessages(prev => {
      if (!active || !((msg.from === active.id && msg.to === me?.id) || (msg.from === me?.id && msg.to === active.id))) return prev;
      if (prev.some(m => m.id === msg.id)) return prev;
      return [...prev, msg];
    }));
    s.on("incoming-call", data => setIncoming(data));
    s.on("call-unavailable", () => alert("User is offline or unavailable."));
    s.on("call-rejected", () => { alert("Call rejected."); endLocalCall(false); });
    s.on("call-ended", () => endLocalCall(false));
    s.on("call-answered", async ({ answer }) => {
      if (pcRef.current) await pcRef.current.setRemoteDescription(answer);
    });
    s.on("ice-candidate", async ({ candidate }) => {
      try { if (pcRef.current && candidate) await pcRef.current.addIceCandidate(candidate); } catch {}
    });

    return () => currentSocket?.disconnect();
  }, [token, active?.id, me?.id]);

  function logout() {
    localStorage.removeItem("chat_token");
    setToken("");
    setMe(null);
    setContacts([]);
    setActive(null);
    setMessages([]);
  }

  async function openChat(user) {
    setActive(user);
    setView("chats");
    try {
      const data = await api(`/api/messages/${user.id}`, token);
      setMessages(data);
      socket?.emit("mark-read", { withUser: user.id });
    } catch (e) {
      setError(e.message);
    }
  }

  async function setupPeer(otherId, video) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    pcRef.current = pc;
    pc.onicecandidate = e => e.candidate && socket.emit("ice-candidate", { to: otherId, candidate: e.candidate });
    pc.ontrack = e => {
      if (remoteRef.current) remoteRef.current.srcObject = e.streams[0];
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    if (localRef.current) localRef.current.srcObject = stream;
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    return { pc, stream };
  }

  async function startCall(video) {
    if (!active || !socket) return;
    try {
      const { pc, stream } = await setupPeer(active.id, video);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      setCall({ user: active, video, stream, muted: false, cameraOff: !video });
      socket.emit("call-user", { to: active.id, offer, video });
    } catch {
      alert("Camera/microphone permission is required.");
    }
  }

  async function acceptCall() {
    const inc = incoming;
    if (!inc || !socket) return;
    try {
      const other = contacts.find(c => c.id === inc.from) || { id: inc.from, displayName: "Contact" };
      const { pc, stream } = await setupPeer(inc.from, inc.video);
      await pc.setRemoteDescription(inc.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      setCall({ user: other, video: inc.video, stream, muted: false, cameraOff: !inc.video });
      socket.emit("answer-call", { to: inc.from, answer });
      setIncoming(null);
    } catch {
      socket.emit("reject-call", { to: inc.from });
      setIncoming(null);
    }
  }

  function rejectCall() {
    if (incoming && socket) socket.emit("reject-call", { to: incoming.from });
    setIncoming(null);
  }

  function endLocalCall(notify = true) {
    const target = call?.user?.id;
    if (notify && target && socket) socket.emit("end-call", { to: target });
    pcRef.current?.close();
    pcRef.current = null;
    call?.stream?.getTracks().forEach(t => t.stop());
    if (localRef.current) localRef.current.srcObject = null;
    if (remoteRef.current) remoteRef.current.srcObject = null;
    setCall(null);
  }

  function toggleMute() {
    const track = call?.stream?.getAudioTracks()?.[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCall(c => ({ ...c, muted: !track.enabled }));
  }

  function toggleCamera() {
    const track = call?.stream?.getVideoTracks()?.[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCall(c => ({ ...c, cameraOff: !track.enabled }));
  }

  if (!token || !me) {
    return <Auth onAuth={({ token: nextToken, user }) => {
      localStorage.setItem("chat_token", nextToken);
      setToken(nextToken);
      setMe(user);
    }} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">PulseChat</div>
        <div className="profile">
          <div className="avatar big">{initials(me.displayName)}</div>
          <div><strong>{me.displayName}</strong><small>@{me.username}</small></div>
          <button className="ghost" onClick={logout}>Logout</button>
        </div>
        <div className="tabs">
          <button className={view === "chats" ? "active" : ""} onClick={() => setView("chats")}>Chats</button>
          <button className={view === "contacts" ? "active" : ""} onClick={() => setView("contacts")}>Add contacts</button>
        </div>
        {view === "contacts"
          ? <ContactFinder token={token} onAdded={u => setContacts(c => c.some(x => x.id === u.id) ? c : [...c, u])} />
          : <ContactList contacts={contacts} active={active} online={online} onOpen={openChat} />
        }
      </aside>

      <main className="main">
        {active ? (
          <>
            <header className="chat-header">
              <div className="contact-title">
                <div className="avatar">{initials(active.displayName)}</div>
                <div>
                  <strong>{active.displayName}</strong>
                  <small>{typing[active.id] ? "typing..." : online[active.id] ? "online" : "offline"}</small>
                </div>
              </div>
              <div className="call-actions">
                <button onClick={() => startCall(false)}>☎ Voice</button>
                <button onClick={() => startCall(true)}>▣ Video</button>
              </div>
            </header>
            <Chat me={me} active={active} socket={socket} messages={messages} />
          </>
        ) : (
          <div className="empty-state">
            <div className="logo-orb">P</div>
            <h1>Your conversations</h1>
            <p>Add a contact, choose a person, and start messaging securely.</p>
          </div>
        )}
      </main>

      {incoming && (
        <div className="modal-backdrop">
          <div className="call-card">
            <h2>Incoming {incoming.video ? "video" : "voice"} call</h2>
            <p>{contacts.find(c => c.id === incoming.from)?.displayName || "A contact"} is calling.</p>
            <div className="row">
              <button className="danger" onClick={rejectCall}>Reject</button>
              <button className="success" onClick={acceptCall}>Accept</button>
            </div>
          </div>
        </div>
      )}

      {call && (
        <div className="call-overlay">
          <video ref={remoteRef} autoPlay playsInline className="remote-video" />
          <video ref={localRef} autoPlay muted playsInline className="local-video" />
          <div className="call-label">{call.user.displayName}</div>
          <div className="call-controls">
            <button onClick={toggleMute}>{call.muted ? "Unmute" : "Mute"}</button>
            {call.video && <button onClick={toggleCamera}>{call.cameraOff ? "Camera on" : "Camera off"}</button>}
            <button className="danger" onClick={() => endLocalCall(true)}>End</button>
          </div>
        </div>
      )}

      {error && <div className="toast" onClick={() => setError("")}>{error}</div>}
    </div>
  );
}

function Auth({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    try {
      const data = await api(`/api/auth/${mode}`, "", {
        method: "POST",
        body: JSON.stringify(form)
      });
      onAuth(data);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="logo-orb">P</div>
        <h1>{mode === "login" ? "Welcome back" : "Create account"}</h1>
        <p className="muted">Secure real-time chat, voice and video.</p>
        <form onSubmit={submit}>
          {mode === "register" && <input placeholder="Display name" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} />}
          <input placeholder="Username" autoComplete="username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
          <input type="password" placeholder="Password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          {error && <div className="error">{error}</div>}
          <button className="primary" type="submit">{mode === "login" ? "Log in" : "Create account"}</button>
        </form>
        <button className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "Need an account? Register" : "Already have an account? Log in"}
        </button>
      </div>
    </div>
  );
}

function ContactList({ contacts, active, online, onOpen }) {
  if (!contacts.length) return <div className="panel-note">No contacts yet. Use “Add contacts”.</div>;
  return (
    <div className="contact-list">
      {contacts.map(c => (
        <button key={c.id} className={`contact ${active?.id === c.id ? "selected" : ""}`} onClick={() => onOpen(c)}>
          <div className="avatar">{initials(c.displayName)}</div>
          <div className="contact-copy"><strong>{c.displayName}</strong><small>@{c.username}</small></div>
          <span className={`dot ${online[c.id] ? "on" : ""}`}></span>
        </button>
      ))}
    </div>
  );
}

function ContactFinder({ token, onAdded }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      api(`/api/users/suggestions?q=${encodeURIComponent(q)}`, token).then(setResults).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q, token]);

  async function add(u) {
    try {
      const added = await api(`/api/contacts/${u.id}`, token, { method: "POST" });
      onAdded(added);
      setResults(r => r.filter(x => x.id !== u.id));
      setMsg(`${u.displayName} added.`);
    } catch (e) {
      setMsg(e.message);
    }
  }

  return (
    <div className="finder">
      <input placeholder="Search people..." value={q} onChange={e => setQ(e.target.value)} />
      {msg && <div className="panel-note">{msg}</div>}
      {results.map(u => (
        <div className="suggestion" key={u.id}>
          <div className="avatar">{initials(u.displayName)}</div>
          <div className="contact-copy"><strong>{u.displayName}</strong><small>@{u.username}</small></div>
          <button onClick={() => add(u)}>Add</button>
        </div>
      ))}
    </div>
  );
}

function Chat({ me, active, socket, messages }) {
  const [text, setText] = useState("");
  const endRef = useRef(null);
  const typingTimer = useRef(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  function change(v) {
    setText(v);
    socket?.emit("typing", { to: active.id, isTyping: true });
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => socket?.emit("typing", { to: active.id, isTyping: false }), 800);
  }

  function send(e) {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || !socket) return;
    setText("");
    socket.emit("typing", { to: active.id, isTyping: false });
    socket.emit("send-message", { to: active.id, text: clean }, res => {
      if (!res?.ok) alert(res?.error || "Message failed");
    });
  }

  return (
    <>
      <section className="messages">
        {messages.map(m => (
          <div key={m.id} className={`bubble-wrap ${m.from === me.id ? "mine" : ""}`}>
            <div className="bubble">
              <div>{m.text}</div>
              <small>
                {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {m.from === me.id ? (m.readAt ? " · Read" : " · Sent") : ""}
              </small>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </section>
      <form className="composer" onSubmit={send}>
        <input value={text} onChange={e => change(e.target.value)} placeholder={`Message ${active.displayName}`} maxLength={3000} />
        <button className="primary">Send</button>
      </form>
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
