import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { session } from "./lib/auth.svelte";
import { loadConfig } from "./lib/config";

await loadConfig();
void session.restore();

mount(App, { target: document.getElementById("app") ?? document.body });
