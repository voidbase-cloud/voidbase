// The app's configuration, named where the build can read it, with Void's validators. vb_secrets/secrets.json
// (git-ignored in a real project; a fixture here) holds the local values; `voidbase deploy` stores the secrets as
// the Worker's secrets and the rest as its vars.
import { browser, defineSecrets, number, secret, server, string } from "@voidbase-cloud/voidbase/secrets";

export default defineSecrets({
  TEST_SECRET: secret(string(), "a value the fixture reads back through $os.getenv"),
  OTHER_SECRET: secret(string(), "declared, valued nowhere: the deploy refuses until it is on the Worker"),
  MAX_ITEMS: server(number().default(3)),
  PUBLIC_LABEL: browser(string().default("fixture")),
});
