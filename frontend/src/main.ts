import "./app.css";
import "./router";
import { mount } from "svelte";
import App from "./App.svelte";

let app = null;
const target = document.getElementById("app") ? document.getElementById("app") : document.body;
if (target) {
  app = mount(App, { target });
}

export default app;
