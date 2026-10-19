import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeLogService, writeLog } from "./services/logService";

initializeLogService();
writeLog("info", "app", "Frontend entry point loaded");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
