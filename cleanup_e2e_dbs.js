const fs=require("fs"),path=require("path");
const envFile=fs.readFileSync(path.join(__dirname,".env"),"utf8");
const BASE=(envFile.match(/^MONGODB_URI=(.+)$/m)||[])[1];
const mongoose=require(path.join(__dirname,"node_modules/mongoose"));

// HARD GUARD: only ever drop databases that look like a throwaway E2E
// scratch DB, and never "freshmart". The pattern alone is not enough, so the
// production name is checked explicitly before any drop.
const PROD = "freshmart";
function isDisposable(name) {
  if (!name) return false;
  if (name === PROD) return false;
  if (name.indexOf(PROD) !== -1) return false;
  return /^fm_[a-z0-9_]*_e2e_[0-9]+$/.test(name);
}

(async()=>{
  await mongoose.connect(BASE);
  const admin=mongoose.connection.db.admin();
  const {databases}=await admin.listDatabases();
  const stale=databases.map(d=>d.name).filter(isDisposable);
  console.log("disposable isolated E2E databases: "+stale.length);
  for(const n of stale){
    if(!isDisposable(n)){ console.log("SKIPPED (not disposable): "+n); continue; }
    await mongoose.connection.client.db(n).dropDatabase();
    console.log("dropped isolated DB: "+n);
  }
  const after=(await admin.listDatabases()).databases.map(d=>d.name);
  console.log("production db still present: "+after.indexOf(PROD)!==-1);
  await mongoose.connection.close();
})().catch(e=>{console.error("ERR "+e.message);process.exit(1);});
