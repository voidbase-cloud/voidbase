// The secrets this app needs, named where the build can read them. vb_secrets/secrets.json (git-ignored in a real
// project; a fixture here) holds their values locally; `voidbase deploy` stores them as the Worker's secrets.
import { defineSecrets } from "@voidbase-cloud/voidbase/adapter";

export default defineSecrets({
  TEST_SECRET: "a value the fixture reads back through $os.getenv",
  OTHER_SECRET: "declared, valued nowhere: the deploy refuses until it is on the Worker",
});
