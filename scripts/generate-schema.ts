import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { manifestSchema } from '../packages/contracts/src/index';
const schema = z.toJSONSchema(manifestSchema);
writeFileSync(
  'packages/contracts/manifest.schema.json',
  JSON.stringify(
    {
      ...schema,
      title: 'JustTaken capture manifest v1',
      description:
        'Structural schema. Apply manifestSchema at runtime for cross-field role, size, duration and codec rules.',
    },
    null,
    2,
  ) + '\n',
);
