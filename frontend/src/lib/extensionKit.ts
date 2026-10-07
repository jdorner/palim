/**
 * Public UI kit for extension pages, importable from extension code as `@palim/ui`.
 *
 * The extension UI builder compiles these sources into each extension bundle, so
 * extension pages render with the same components and look as core pages. Only
 * stateless components and pure helpers may be exported here: extension bundles get
 * their own copy of every module they import, so a stateful module (router, stores,
 * WebSocket connection, auth) would be instantiated a second time. Extensions reach
 * host state through the `palim` host object instead.
 *
 * This is a public API for extension authors: removing an export or changing a
 * component's props is a breaking change.
 *
 * @module
 */

export { default as LoadingIndicator } from "$lib/components/LoadingIndicator.svelte";
export { default as ToggleSwitch } from "$lib/components/ToggleSwitch.svelte";
export { AlertDialog } from "$lib/components/ui/alert-dialog";
export { Badge, type BadgeVariant } from "$lib/components/ui/badge";
export { Button, type ButtonSize, type ButtonVariant } from "$lib/components/ui/button";
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "$lib/components/ui/card";
export { Checkbox } from "$lib/components/ui/checkbox";
export { Dialog } from "$lib/components/ui/dialog";
export { Label } from "$lib/components/ui/label";
export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "$lib/components/ui/select";
export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
export { cn } from "$lib/utils";
export { default as MultiSelect } from "../components/MultiSelect.svelte";
export { default as StatusDot } from "../components/StatusDot.svelte";
