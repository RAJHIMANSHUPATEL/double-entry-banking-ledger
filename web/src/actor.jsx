import { createContext, useContext, useEffect, useState } from "react";

const ActorContext = createContext({ actor: "reviewer", setActor() {} });

export function ActorProvider({ children }) {
  const [actor, setActor] = useState(() => sessionStorage.getItem("actor") || "reviewer");
  useEffect(() => {
    sessionStorage.setItem("actor", actor);
  }, [actor]);
  return <ActorContext.Provider value={{ actor, setActor }}>{children}</ActorContext.Provider>;
}

export function useActor() {
  return useContext(ActorContext);
}
