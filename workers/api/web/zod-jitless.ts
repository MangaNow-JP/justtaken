// Imported first: schemas created by later imports must not probe eval, which the CSP forbids.
import { z } from 'zod';
z.config({ jitless: true });
