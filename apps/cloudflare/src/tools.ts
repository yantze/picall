import { WebTools as Base } from '../../../packages/tools/index.js';
import { researchRegistry } from '../../../packages/core/registry.js';
export { parseWebURL, boundedText, contentIssue, previewOffset } from '../../../packages/tools/index.js';
export type ToolEnv = { BRAVE_KEY?:string; TAVILY_KEY?:string; TINYFISH_KEY?:string; EXA_KEY?:string; JINA_KEY?:string; BRAVE_BASE_URL:string; TAVILY_BASE_URL:string; HTTP_TOOLS:string };
export type Scope = { id:string; deadline:number };
export type Store = { get<T>(key:string):Promise<T|undefined>; put(key:string,value:any):Promise<unknown> };
export class WebTools extends Base {
  registry(options: any = {}): any { return researchRegistry(this, options); }
}
