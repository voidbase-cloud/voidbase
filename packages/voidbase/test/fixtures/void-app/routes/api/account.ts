// The page loader above, mounted as a route: a prerendered page has no runtime here (docs/adapter.md), so this is
// where the same module answers. The loader itself is unchanged -- it is `defineHandler`, which is what a route is.
export { loader as GET } from "@/pages/account.server";
