import { NavLink, Route, Routes } from "react-router-dom";
import { ActorProvider, useActor } from "./actor.jsx";
import { Dashboard } from "./pages/Dashboard.jsx";
import { PostEntry } from "./pages/PostEntry.jsx";
import { Statement } from "./pages/Statement.jsx";

const links = [
  ["/", "Dashboard"],
  ["/post", "Post entry"],
  ["/statement", "Statement"],
];

function Frame() {
  const { actor, setActor } = useActor();
  return (
    <div className="shell">
      <aside className="rail">
        <p className="mark">Paise Ledger</p>
        <p className="fictional">Fictional books for Anaya Studio.</p>
        <nav>
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              {label}
            </NavLink>
          ))}
        </nav>
        <label className="actor">
          Actor
          <input value={actor} maxLength={64} onChange={(event) => setActor(event.target.value)} />
        </label>
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/post" element={<PostEntry />} />
          <Route path="/statement" element={<Statement />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ActorProvider>
      <Frame />
    </ActorProvider>
  );
}
