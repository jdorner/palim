/**
 * Standalone skill discovery and script loading utilities.
 *
 * Extracted from ExtensionRegistry so both the full boot sequence and
 * lightweight CLI tools (sandboxCLI) can share the same logic without
 * pulling in DB, queue, or Elysia dependencies.
 */

import { serverOrigin } from "@src/config";
import type { SkillScriptContext } from "@src/extensions/types";
import { parseSkillMd } from "@src/skills/frontmatter";
import { registerProgram, type SkillEntry } from "@src/tools/sandbox";
import { authenticatedFetch } from "@src/utils/fetch";
import createLogger from "logging";

const logger = createLogger("SkillLoader");

/** Constructs the extension base URL for skill script contexts. */
function extensionBaseUrl(extensionName: string): string {
  return `${serverOrigin()}/ext/${extensionName}`;
}

/**
 * Scans extension directories for co-located skills (SKILL.md files)
 * and returns a populated skill map.
 *
 * @param extensionDirs - Directories to scan for `<ext>/skills/<name>/SKILL.md`
 * @returns Map of skill name -> SkillEntry
 */
export async function discoverSkills(extensionDirs: string[]): Promise<Map<string, SkillEntry>> {
  const skillMap = new Map<string, SkillEntry>();

  for (const dir of extensionDirs) {
    try {
      const patterns = ["*/skills/*/SKILL.md", "core/*/skills/*/SKILL.md"];

      for (const pattern of patterns) {
        const glob = new Bun.Glob(pattern);
        const entries = await Array.fromAsync(glob.scan({ cwd: dir, absolute: false }));

        for (const entry of entries) {
          const parts = entry.split("/");
          // For "core/scheduler/skills/scheduler/SKILL.md" -> extensionName = parts[1]
          // For "steering/skills/steering/SKILL.md" -> extensionName = parts[0]
          const isNested = parts[0] === "core";
          const extensionName = isNested ? parts[1]! : parts[0]!;
          const skillDirName = isNested ? parts[3]! : parts[2]!;
          const fullPath = `${dir}/${entry}`;
          const skillDir = isNested
            ? `${dir}/core/${extensionName}/skills/${skillDirName}`
            : `${dir}/${extensionName}/skills/${skillDirName}`;

          try {
            const content = await Bun.file(fullPath).text();
            const parsed = parseSkillMd(content);

            if (parsed.error) {
              logger.error(`Failed to parse skill file ${fullPath}: ${parsed.errorMessage}`);
              continue;
            }

            if (!parsed.frontmatter.name || !parsed.frontmatter.description) {
              logger.error(`Skill file ${fullPath} is missing required frontmatter fields`);
              continue;
            }

            const skillName = parsed.frontmatter.name as string;

            if (skillMap.has(skillName)) {
              const existing = skillMap.get(skillName)!;
              logger.error(
                `Duplicate skill name "${skillName}" from extension "${extensionName}" - ` +
                  `already registered by extension "${existing.extensionName}". Skipping duplicate.`,
              );
              continue;
            }

            const skillEntry: SkillEntry = {
              name: skillName,
              directory: skillDir,
              frontmatter: parsed.frontmatter as SkillEntry["frontmatter"],
              extensionName,
              programNames: [],
            };

            skillMap.set(skillName, skillEntry);
            logger.debug(`Discovered skill "${skillName}" from extension "${extensionName}"`);
          } catch (err) {
            logger.error(`Failed to read skill file ${fullPath}:`, err);
          }
        }
      }
    } catch {
      logger.debug(`Extensions directory not found or unreadable: ${dir}`);
    }
  }

  logger.info(
    `Discovered ${skillMap.size} skill(s): ${[...skillMap.keys()].toSorted((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).join(", ") || "(none)"}`,
  );
  return skillMap;
}

/**
 * Discovers skills for a single extension directory and merges them into
 * an existing skill map. Used during hot-loading when only one extension's
 * skills need to be registered without re-scanning all directories.
 *
 * @param extensionName - The extension name that owns these skills
 * @param extDir - Absolute path to the extension's root directory
 * @param skillMap - The existing skill map to merge into (mutated in place)
 * @returns `true` if any new skills were discovered
 */
export async function discoverExtensionSkills(
  extensionName: string,
  extDir: string,
  skillMap: Map<string, SkillEntry>,
): Promise<boolean> {
  let found = false;

  try {
    const glob = new Bun.Glob("skills/*/SKILL.md");
    const entries = await Array.fromAsync(glob.scan({ cwd: extDir, absolute: false }));

    for (const entry of entries) {
      const parts = entry.split("/");
      const skillDirName = parts[1]!;
      const fullPath = `${extDir}/${entry}`;
      const skillDir = `${extDir}/skills/${skillDirName}`;

      try {
        const content = await Bun.file(fullPath).text();
        const parsed = parseSkillMd(content);

        if (parsed.error) {
          logger.error(`Failed to parse skill file ${fullPath}: ${parsed.errorMessage}`);
          continue;
        }

        if (!parsed.frontmatter.name || !parsed.frontmatter.description) {
          logger.error(`Skill file ${fullPath} is missing required frontmatter fields`);
          continue;
        }

        const skillName = parsed.frontmatter.name as string;

        if (skillMap.has(skillName)) {
          const existing = skillMap.get(skillName)!;
          logger.error(
            `Duplicate skill name "${skillName}" from extension "${extensionName}" - ` +
              `already registered by extension "${existing.extensionName}". Skipping duplicate.`,
          );
          continue;
        }

        const skillEntry: SkillEntry = {
          name: skillName,
          directory: skillDir,
          frontmatter: parsed.frontmatter as SkillEntry["frontmatter"],
          extensionName,
          programNames: [],
        };

        skillMap.set(skillName, skillEntry);
        logger.debug(`Discovered skill "${skillName}" from extension "${extensionName}"`);
        found = true;
      } catch (err) {
        logger.error(`Failed to read skill file ${fullPath}:`, err);
      }
    }
  } catch {
    // No skills directory - that's fine
  }

  return found;
}

/**
 * Loads skill scripts for all entries in the provided skill map.
 * Each script's `registerSkill()` export is called with a proper
 * {@link SkillScriptContext} containing pre-built URLs.
 *
 * @param skillMap - Map of skill name -> SkillEntry (from {@link discoverSkills})
 * @param primaryExtensionsDir - The built-in extensions directory (used for `extensionsDir` in context)
 * @returns Number of skill scripts successfully loaded
 */
export async function loadSkillScripts(
  skillMap: ReadonlyMap<string, SkillEntry>,
  primaryExtensionsDir: string,
): Promise<number> {
  let totalLoaded = 0;

  for (const [skillName, entry] of skillMap) {
    const scriptsDir = `${entry.directory}/scripts`;
    const scriptCtx: SkillScriptContext = {
      baseUrl: extensionBaseUrl(entry.extensionName),
      serverUrl: serverOrigin(),
      extensionsDir: primaryExtensionsDir,
      fetch: authenticatedFetch,
      registerProgram,
    };

    try {
      const stat = await Bun.file(scriptsDir)
        .stat()
        .catch(() => null);
      if (!stat?.isDirectory()) continue;

      const glob = new Bun.Glob("*.ts");
      const scriptEntries = await Array.fromAsync(glob.scan({ cwd: scriptsDir }));

      for (const scriptEntry of scriptEntries) {
        if (scriptEntry.endsWith(".test.ts")) continue;

        const scriptPath = `${scriptsDir}/${scriptEntry}`;
        try {
          const mod = await import(scriptPath);
          if (mod.registerSkill) {
            await mod.registerSkill(skillName, scriptCtx);
            totalLoaded++;
            logger.debug(`Loaded skill script: ${scriptPath}`);
          } else {
            logger.warn(`Script ${scriptPath} does not export a registerSkill function`);
          }
        } catch (err) {
          logger.error(`Failed to load skill script ${scriptPath}: ${err}`);
        }
      }
    } catch (err) {
      logger.error(`Failed to scan scripts for skill "${skillName}": ${err}`);
    }
  }

  if (totalLoaded > 0) {
    logger.info(`Loaded ${totalLoaded} skill script(s)`);
  }

  return totalLoaded;
}
