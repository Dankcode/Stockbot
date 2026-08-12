import { BrowserRouter } from "react-router-dom";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../styles/components.css";
import "../styles/overview.css";
import "../styles/markets.css";
import "../styles/sessions.css";
import "../styles/strategies.css";
import "../styles/settings.css";
import { AppRoutes } from "./routes";

export function App() {
  return <BrowserRouter><AppRoutes /></BrowserRouter>;
}
