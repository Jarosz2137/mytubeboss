// Prefer verified synced lyrics; plain results are only a short-lived fallback.
import { CapacitorHttp } from '@capacitor/core';
import * as yt from './yt.js';

const cache = new Map(), inflight = new Map();
const clean = s => String(s || '').replace(/\s*[([].*?(feat|ft\.|official|video|audio|remaster|lyric|prod)[^)\]]*[)\]]/gi, '').trim();
const key = s => clean(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function parseLrc(lrc) {
  const offset = Number((lrc || '').match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0)/1000;
  const out = [];
  for (const line of (lrc || '').split('\n')) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = line.replace(/\[[^\]]*\]/g,'').trim();
    for (const t of stamps) out.push({t:Math.max(0,Number(t[1])*60+Number(t[2])+offset),text});
  }
  return out.sort((a,b)=>a.t-b.t);
}
async function request(path, params) {
  const r = await CapacitorHttp.get({url:'https://lrclib.net/api/'+path+'?'+new URLSearchParams(params), headers:{'User-Agent':'MyTubeBoss/1.0'}, responseType:'json', connectTimeout:5000,readTimeout:5000});
  if(r.status>=400)return null;
  return typeof r.data==='string'?JSON.parse(r.data||'null'):r.data;
}
function result(d) {
  const lines=parseLrc(d?.syncedLyrics);
  if(lines.length && lines.some(l=>l.text))return {synced:true,lines,source:'LRCLIB'};
  if(d?.plainLyrics)return {synced:false,lines:d.plainLyrics.split('\n').map(text=>({text})),source:'LRCLIB'};
  return null;
}
export function getLyrics(track) {
  if(!track)return Promise.resolve(null);
  const id=track.id, hit=cache.get(id);
  if(hit && hit.until>Date.now())return Promise.resolve(hit.value);
  if(inflight.has(id))return inflight.get(id);
  const job=fetchLyrics(track).then(value=>{
    cache.set(id,{value,until:Date.now()+(value?.synced?86400000:120000)});
    while(cache.size>100)cache.delete(cache.keys().next().value);
    console.info('[lyrics]',id,value?.source||'none',value?.synced?'synced':'plain/unavailable',value?.lines.length||0);
    return value;
  }).finally(()=>inflight.delete(id));
  inflight.set(id,job);return job;
}
async function fetchLyrics(track) {
  const title=clean(track.title);
  const parts=String(track.subtitle||'').split(' · ').filter(x=>! /^(utwór|song|video|teledysk|album|single)$/i.test(x.trim()));
  const artist=clean(track.artists?.find(a=>a?.name)?.name || (parts[0]||'').split(',')[0]);
  const duration=Number(track.duration)||0;
  const params={track_name:title,artist_name:artist};
  let fallback=null;
  try {
    const d=await request('get',duration?{...params,duration:String(Math.round(duration))}:params);
    const v=result(d);
    if(v?.synced)return v;
    fallback=v;
  }catch(e){console.warn('[lyrics] exact',e?.message);}
  try {
    const list=await request('search',params);
    const matches=(Array.isArray(list)?list:[]).filter(d=>{
      if(key(d.trackName)!==key(title))return false;
      const names=key(d.artistName), target=key(artist);
      if(!target||!(names===target||names.startsWith(target+' ')))return false;
      return !duration || !d.duration || Math.abs(d.duration-duration)<=5;
    }).sort((a,b)=>Math.abs((a.duration||duration)-duration)-Math.abs((b.duration||duration)-duration));
    for(const d of matches){const v=result(d);if(v?.synced)return v;if(!fallback&&v)fallback=v;}
  }catch(e){console.warn('[lyrics] search',e?.message);}
  if(fallback)return fallback;
  try{
    const ytm=await yt.getYT();
    const l=await ytm.music.getLyrics(track.id);
    const text=yt.txt(l?.description);
    if(text)return {synced:false,lines:text.split('\n').map(text=>({text})),source:'YouTube Music'};
  }catch(e){console.warn('[lyrics] yt',e?.message);}
  return null;
}
