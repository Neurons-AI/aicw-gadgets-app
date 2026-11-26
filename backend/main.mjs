// Backend of AICW Gadgets. One function per command declared in app.json.
// (args, ctx): args = what the page sent; ctx = the platform (references/backend.md).
//
// Try a command without the app:
//   node <app-creator>/scripts/dev_app.mjs <this app dir> call hello '{"name":"Lan"}'

export const commands = {
  // An example. Replace it with your own commands (and declare each one in app.json).
  async hello({ name }, ctx) {
    const visits = ((await ctx.store.user.get('visits')) || 0) + 1;
    await ctx.store.user.set('visits', visits);
    return { message: `Hello ${name || ctx.user.name || 'there'}!`, visits };
  },
};
