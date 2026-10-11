import { describe, expect, test } from "bun:test";
import { matchRoute } from "./routeMatch";

describe("matchRoute", () => {
  test("matches static and parameter segments", () => {
    expect(matchRoute("/tasks", "/tasks")).toEqual({});
    expect(matchRoute("/tasks/:id", "/tasks/a%20b")).toEqual({ id: "a b" });
    expect(matchRoute("/tasks/:id", "/tasks")).toBeNull();
    expect(matchRoute("/tasks", "/settings")).toBeNull();
    expect(matchRoute("/tasks/:id", "/tasks/x?tab=1")).toEqual({ id: "x" });
  });
});
