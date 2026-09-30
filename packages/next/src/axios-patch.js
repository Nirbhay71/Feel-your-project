// Only for apps that use axios: patch the app's own axios so the stack of
// the code that *called* axios is kept (see @feel-dev/client's axios.js).
// withFeel aliases "@feel-dev/next/axios" to this file when axios is
// installed, so apps without it never try to import it.

import axios from 'axios';
import { patchAxios } from '@feel-dev/client/axios';

patchAxios(axios);
