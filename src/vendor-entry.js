import nspell from "nspell";
import { createClient } from "@supabase/supabase-js";
window.nspell = nspell;
window.supabase = { createClient };
