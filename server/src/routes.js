import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';
import { User,TrekStaff,Admin,Trek,Booking } from './models.js';
import { resolveTrekImageUrl } from './trek-images.js';
import { getJwtSecret } from './config.js';
import { apiNotFound, asyncHandler, validateObjectIdParam } from './http.js';
import { buildTrekListFilter, buildUserSearchFilter, TREK_USER_DETAIL_STATUSES } from './query.js';
import { serializeBooking, serializePublicProfile, serializeTrek, serializeUser } from './serializers.js';
import { handleImageUpload } from './uploads.js';
dotenv.config();
const router=Router();
const cloudinaryCredentials={
 cloud_name:process.env.CLOUDINARY_CLOUD_NAME,
 api_key:process.env.CLOUDINARY_API_KEY,
 api_secret:process.env.CLOUDINARY_API_SECRET
};
const cloudinaryConfigured=Object.values(cloudinaryCredentials).every(Boolean);
if(cloudinaryConfigured)cloudinary.config(cloudinaryCredentials);
const uploadToCloudinary=file=>new Promise((resolve,reject)=>{
 if(!cloudinaryConfigured){const error=new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.');error.status=503;return reject(error);}
 cloudinary.uploader.upload_stream({folder:'trekmate/treks',resource_type:'image'},(error,result)=>{
  if(error){error.status=502;return reject(error);}
  if(!result?.secure_url)return reject(Object.assign(new Error('Cloudinary did not return a secure image URL.'),{status:502}));
  resolve(result.secure_url);
 }).end(file.buffer);
});
const getModelByRole=(role)=>{
 if(role==='Staff'||role==='TrekStaff')return TrekStaff;
 if(role==='Admin')return Admin;
 return User;
};
function auth(req,res,next){
 const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 try{
  if(!token)throw Error();
  req.auth=jwt.verify(token,getJwtSecret(),{algorithms:['HS256']});
  next();
 }catch{
  return res.status(401).json({message:'Please log in to continue.'});
 }
}
function optionalAuth(req,_res,next){
 const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!token)return next();
 try{req.auth=jwt.verify(token,getJwtSecret(),{algorithms:['HS256']});}catch{}
 next();
}
function allow(...roles){return async(req,res,next)=>{try{
 const Model=getModelByRole(req.auth.role); const user=await Model?.findById(req.auth.id);
 if(!user)return res.status(401).json({message:'Account not found.'});
 if(!roles.includes(user.role))return res.status(403).json({message:'You do not have permission to access this resource.'});
 if(user.status==='Blacklisted')return res.status(403).json({message:'Your account has been blacklisted.'});
 if(user.role==='Staff'&&user.status!=='Approved')return res.status(403).json({message:'Your staff account is awaiting approval.'});
 req.user=user;next();
 }catch(e){next(e);}}}
const populateTrek={path:'assignedStaff',select:'name'};
const populateBookingUser={path:'user',select:'name email role status'};
const getTrek=async(id)=>Trek.findById(id).populate(populateTrek);
router.post('/auth/register',asyncHandler(async(req,res)=>{
 try{
  const {name,email,password,confirmPassword,role='User'}=req.body;
  if(!name||!email||!password)return res.status(400).json({message:'Name, email/contact, and password are required.'});
  if(password!==confirmPassword)return res.status(400).json({message:'Passwords do not match.'});
  if(role==='Admin')return res.status(400).json({message:'Admin registration is not allowed.'});
  if(!['User','Staff'].includes(role))return res.status(400).json({message:'Invalid role.'});
  const Model=role==='Staff'?TrekStaff:User; const key=role==='Staff'?'contactDetails':'email';
  if(await Model.findOne({[key]:email}))return res.status(409).json({message:'An account with this email/contact already exists.'});
  await Model.create({name,[key]:email,passwordHash:await bcrypt.hash(password,12),role});
  res.status(201).json({message:role==='Staff'?'Registration successful. Your account requires admin approval.':'Registration successful. Please log in.'});
 }catch(e){
  if(e.code===11000)return res.status(409).json({message:'Account already exists.'});
  throw e;
 }
}));
router.post('/auth/login',asyncHandler(async(req,res)=>{
 const {email,password}=req.body;
 if(typeof email!=='string'||typeof password!=='string')return res.status(400).json({message:'Email and password are required.'});
 const normalizedEmail=email.toLowerCase();
 let u=await User.findOne({email:normalizedEmail}).select('+passwordHash');
 if(!u)u=await TrekStaff.findOne({contactDetails:email}).select('+passwordHash');
 if(!u)u=await Admin.findOne({email:normalizedEmail}).select('+passwordHash');
 if(!u||!await bcrypt.compare(password,u.passwordHash))return res.status(401).json({message:'Invalid credentials.'});
 if(u.status==='Blacklisted')return res.status(403).json({message:'Your account has been blacklisted. Please contact admin.'});
 if(u.role==='Staff'&&u.status!=='Approved')return res.status(403).json({message:'Your staff account is not approved yet.'});
 const token=jwt.sign({id:u._id,role:u.role},getJwtSecret(),{algorithm:'HS256',expiresIn:'7d'});
 res.json({token,user:serializeUser(u)});
}));
router.get('/auth/me',auth,asyncHandler(async(req,res)=>{
 const Model=getModelByRole(req.auth.role);
 const u=await Model?.findById(req.auth.id);
 if(!u)return res.status(401).json({message:'Account not found'});
 res.json({user:serializeUser(u)});
}));
router.patch('/profile',auth,asyncHandler(async(req,res)=>{
 const Model=getModelByRole(req.auth.role);
 const u=await Model?.findById(req.auth.id);
 if(!u)return res.status(401).json({message:'Account not found.'});
 try{
  if(req.body.name)u.name=req.body.name;
  if(req.auth.role==='Staff'&&req.body.email)u.contactDetails=req.body.email;
  if(req.auth.role!=='Staff'&&req.body.email)u.email=req.body.email;
  if(req.body.password)u.passwordHash=await bcrypt.hash(req.body.password,12);
  await u.save();
  res.json({user:serializeUser(u),message:'Profile updated successfully.'});
 }catch(e){
  if(e.code===11000)return res.status(400).json({message:'Email already in use.'});
  throw e;
 }
}));
router.get('/treks',optionalAuth,asyncHandler(async(req,res)=>{
 const q=buildTrekListFilter({
  status:req.query.status,
  publicOnly:req.query.public==='true',
  difficulty:req.query.difficulty,
  region:req.query.region,
  isAdmin:req.auth?.role==='Admin'
 });
 const treks=await Trek.find(q).populate(populateTrek).sort({startDate:1});
 res.json(treks.map(serializeTrek));
}));
router.get('/treks/:id',auth,validateObjectIdParam(),asyncHandler(async(req,res)=>{
 const t=await getTrek(req.params.id);
 if(!t)return res.status(404).json({message:'Trek not found'});
 if(req.auth.role!=='Admin'&&req.auth.role!=='Staff'&&!TREK_USER_DETAIL_STATUSES.includes(t.status))return res.status(404).json({message:'Trek not found'});
 res.json(serializeTrek(t));
}));
router.post('/treks',auth,allow('Admin'),handleImageUpload,asyncHandler(async(req,res)=>{
 try{
  const b=req.body;const startDate=new Date(b.startDate),endDate=new Date(b.endDate);
  if(!(endDate>startDate))return res.status(400).json({message:'End date must be strictly after the start date.'});
  if(+b.availableSlots<1||+b.duration<1)return res.status(400).json({message:'Slots and duration must be positive integers.'});
  const imageUrl=req.file?await uploadToCloudinary(req.file):resolveTrekImageUrl({region:b.region||'Nepal'});
  const t=await Trek.create({
   name:b.name,
   region:b.region||'Nepal',
   location:b.region||'Nepal',
   difficulty:b.difficulty,
   duration:+b.duration,
   availableSlots:+b.availableSlots,
   price:+b.price||0,
   avgTime:b.avgTime||'',
   avgDistance:b.avgDistance||'',
   avgGain:b.avgGain||'',
   avgLoss:b.avgLoss||'',
   assignedStaff:b.assignedStaffId||null,
   startDate,
   endDate,
   status:b.assignedStaffId?'Approved':'Pending',
   description:b.description||'',
   detailedDescription:b.detailedDescription||'',
   imageUrl
  });
  res.status(201).json({trek:serializeTrek(await getTrek(t._id)),message:'Trek added successfully.'});
 }catch(e){
  if(e.status)return res.status(e.status).json({message:e.message});
  if(e.name==='ValidationError'||e.name==='CastError')return res.status(400).json({message:'Invalid trek data.'});
  throw e;
 }
}));
router.patch('/treks/:id',auth,allow('Admin'),validateObjectIdParam(),handleImageUpload,asyncHandler(async(req,res)=>{
 try{
  const t=await Trek.findById(req.params.id);if(!t)return res.status(404).json({message:'Trek not found'});
  for(const k of ['name','region','difficulty','description','detailedDescription','avgTime','avgDistance','avgGain','avgLoss'])if(req.body[k]!==undefined)t[k]=req.body[k];
  if(req.body.region!==undefined)t.location=req.body.region;
  for(const k of ['duration','availableSlots','price'])if(req.body[k]!==undefined)t[k]=Number(req.body[k]);
  if(req.body.startDate)t.startDate=new Date(req.body.startDate);if(req.body.endDate)t.endDate=new Date(req.body.endDate);
  if(req.body.assignedStaffId!==undefined)t.assignedStaff=req.body.assignedStaffId||null;
  if(req.file){t.imageUrl=await uploadToCloudinary(req.file);t.imageFilename='';}
  else if(!t.imageUrl&&!t.imageFilename)t.imageUrl=resolveTrekImageUrl({region:t.region||'Nepal'});
  if(!(t.endDate>t.startDate)||t.duration<1||t.availableSlots<0)return res.status(400).json({message:'Check dates, duration, and available slots.'});
  await t.save();
  res.json({trek:serializeTrek(await getTrek(t._id)),message:'Trek updated successfully.'});
 }catch(e){
  if(e.status)return res.status(e.status).json({message:e.message});
  if(e.name==='ValidationError'||e.name==='CastError')return res.status(400).json({message:'Invalid trek data.'});
  throw e;
 }
}));
router.delete('/treks/:id',auth,allow('Admin'),validateObjectIdParam(),asyncHandler(async(req,res)=>{
 const t=await Trek.findByIdAndDelete(req.params.id);
 if(!t)return res.status(404).json({message:'Trek not found'});
 await Booking.deleteMany({trek:t._id});
 res.json({message:'Trek deleted successfully.'});
}));
router.post('/treks/:id/book',auth,allow('User'),validateObjectIdParam(),asyncHandler(async(req,res)=>{
 const t=await Trek.findById(req.params.id);if(!t)return res.status(404).json({message:'Trek not found'});
 if(t.status!=='Open')return res.status(400).json({message:'This trek is not currently open for booking.'});
 if(t.availableSlots<=0)return res.status(400).json({message:'Sorry, this trek is fully booked.'});
 let b=await Booking.findOne({user:req.user._id,trek:t._id});
 if(b&&b.status!=='Cancelled')return res.status(409).json({message:'You have already booked this trek.'});
 if(b)b.status='Booked';else b=new Booking({user:req.user._id,trek:t._id,status:'Booked'});
 const updated=await Trek.findOneAndUpdate({_id:t._id,status:'Open',availableSlots:{$gt:0}},{$inc:{availableSlots:-1}},{new:true});
 if(!updated)return res.status(409).json({message:'Sorry, this trek is fully booked.'});
 try{await b.save();}catch(e){await Trek.updateOne({_id:t._id},{$inc:{availableSlots:1}});throw e;}
 res.status(201).json({message:'Booking successful!',booking:serializeBooking(b)});
}));
router.get('/bookings/mine',auth,allow('User'),asyncHandler(async(req,res)=>{
 const bs=await Booking.find({user:req.user._id}).populate({path:'trek',populate:populateTrek}).sort({bookingDate:-1});
 res.json(bs.map(b=>serializeBooking(b)));
}));
router.post('/bookings/:id/cancel',auth,allow('User'),validateObjectIdParam(),asyncHandler(async(req,res)=>{
 const cancelled=await Booking.findOneAndUpdate(
  {_id:req.params.id,user:req.user._id,status:'Booked'},
  {$set:{status:'Cancelled'}},
  {new:true}
 );
 if(cancelled){
  await Trek.updateOne({_id:cancelled.trek},{$inc:{availableSlots:1}});
  return res.json({message:'Booking cancelled successfully.'});
 }
 const existing=await Booking.findOne({_id:req.params.id,user:req.user._id});
 if(!existing)return res.status(404).json({message:'Booking not found'});
 res.json({message:'Booking cancelled successfully.'});
}));
router.get('/admin/bookings',auth,allow('Admin'),asyncHandler(async(req,res)=>{
 const bs=await Booking.find().sort({bookingDate:-1}).populate(populateBookingUser).populate({path:'trek',populate:populateTrek});
 res.json(bs.map(b=>serializeBooking(b)));
}));
router.get('/admin/summary',auth,allow('Admin'),asyncHandler(async(req,res)=>{
 const [totalTreks,totalUsers,totalStaff,totalBookings,recentBookings,popular]=await Promise.all([
  Trek.countDocuments(),User.countDocuments(),TrekStaff.countDocuments(),Booking.countDocuments(),
  Booking.find().sort({bookingDate:-1}).limit(5).populate(populateBookingUser).populate({path:'trek',populate:populateTrek}),
  Booking.aggregate([{$group:{_id:'$trek',bookingCount:{$sum:1}}},{$sort:{bookingCount:-1}},{$limit:5},{$lookup:{from:'treks',localField:'_id',foreignField:'_id',as:'trek'}},{$unwind:{path:'$trek',preserveNullAndEmptyArrays:true}}])
 ]);
 const statuses=await Booking.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]);
 res.json({totalTreks,totalUsers,totalStaff,totalBookings,recentBookings:recentBookings.map(b=>serializeBooking(b)),popularTreks:popular.map(p=>({trek_name:p.trek?.name||'Deleted trek',booking_count:p.bookingCount})),statusDistribution:Object.fromEntries(statuses.map(s=>[s._id,s.count]))});
}));
router.get('/admin/users',auth,allow('Admin'),asyncHandler(async(req,res)=>{
 const filter=buildUserSearchFilter(req.query.search);
 res.json((await User.find(filter).sort({createdAt:-1})).map(serializeUser));
}));
router.patch('/admin/users/:id/toggle-blacklist',auth,allow('Admin'),validateObjectIdParam(),asyncHandler(async(req,res)=>{
 const u=await User.findById(req.params.id);
 if(!u)return res.status(404).json({message:'User not found'});
 u.status=u.status==='Blacklisted'?'Active':'Blacklisted';
 await u.save();
 res.json({user:serializeUser(u),message:`User ${u.name} status updated.`});
}));
router.get('/admin/staff',auth,allow('Admin'),asyncHandler(async(req,res)=>{
 res.json((await TrekStaff.find().sort({createdAt:-1})).map(serializeUser));
}));
router.patch('/admin/staff/:id/status',auth,allow('Admin'),validateObjectIdParam(),asyncHandler(async(req,res)=>{
 if(!['Pending','Approved','Rejected','Blacklisted'].includes(req.body.status))return res.status(400).json({message:'Invalid staff status'});
 const s=await TrekStaff.findByIdAndUpdate(req.params.id,{status:req.body.status},{new:true});
 if(!s)return res.status(404).json({message:'Staff not found'});
 res.json({user:serializeUser(s),message:'Staff status updated.'});
}));
router.get('/staff/summary',auth,allow('Staff'),asyncHandler(async(req,res)=>{
 const treks=await Trek.find({assignedStaff:req.user._id}).sort({startDate:1});
 const ids=treks.map(t=>t._id);
 const participants=await Booking.countDocuments({trek:{$in:ids}});
 res.json({treks:treks.map(serializeTrek),totalAssigned:treks.length,openTreks:treks.filter(t=>t.status==='Open').length,totalParticipants:participants});
}));
router.get('/staff/treks/:id',auth,allow('Staff'),validateObjectIdParam(),asyncHandler(async(req,res)=>{
 const t=await getTrek(req.params.id);
 if(!t||String(t.assignedStaff?._id)!==String(req.user._id))return res.status(404).json({message:'Assigned trek not found'});
 const bs=await Booking.find({trek:t._id}).populate(populateBookingUser);
 res.json({trek:serializeTrek(t),bookings:bs.map(b=>serializeBooking(b,{includeTrek:false}))});
}));
router.patch('/staff/treks/:id/status',auth,allow('Staff'),validateObjectIdParam(),asyncHandler(async(req,res)=>{
 const t=await Trek.findOne({_id:req.params.id,assignedStaff:req.user._id});
 if(!t)return res.status(404).json({message:'Assigned trek not found'});
 const status=req.body.status;
 if(!['Approved','Open','Started','Completed'].includes(status))return res.status(400).json({message:'Invalid status.'});
 t.status=status;
 await t.save();
 if(status==='Completed')await Booking.updateMany({trek:t._id,status:'Booked'},{$set:{status:'Completed'}});
 res.json({message:`Trek status updated to ${status}.`,trek:serializeTrek(t)});
}));
router.get('/users/:id',validateObjectIdParam(),asyncHandler(async(req,res)=>{
 const u=await User.findById(req.params.id).select('name role');
 if(!u)return res.status(404).json({message:'User not found'});
 res.json(serializePublicProfile(u));
}));
router.get('/bookings/stats',asyncHandler(async(req,res)=>{
 const popular=await Booking.aggregate([{$group:{_id:'$trek',booking_count:{$sum:1}}},{$sort:{booking_count:-1}},{$limit:5},{$lookup:{from:'treks',localField:'_id',foreignField:'_id',as:'trek'}},{$unwind:{path:'$trek',preserveNullAndEmptyArrays:true}},{$project:{trek_name:{$ifNull:['$trek.name','Deleted trek']},booking_count:1}}]);
 const stats=await Booking.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]);
 res.json({popular_treks:popular,status_distribution:Object.fromEntries(stats.map(x=>[x._id,x.count]))});
}));
router.use(apiNotFound);
export default router;
