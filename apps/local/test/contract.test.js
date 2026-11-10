import test from 'node:test';
import { setup } from './helpers.mjs';
import { assertAPIContract } from '../../../test/api-contract.mjs';
test('shared public API contract on Node Harness',async t=>{const fixture=await setup(t);await assertAPIContract(fixture.request);});
