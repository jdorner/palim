/**
 * Application entry point - constructs and starts the AppBootstrap.
 *
 * Loads environment variables (with dotenvx decryption if .env.keys is present)
 * before any other module reads process.env.
 *
 * All subsystem initialization, wiring, and lifecycle management is
 * encapsulated in {@link AppBootstrap} (src/app/boot.ts).
 */

import "@dotenvx/dotenvx/config";
import { AppBootstrap } from "./app/boot";

const boot = await AppBootstrap.create();
await boot.start();
