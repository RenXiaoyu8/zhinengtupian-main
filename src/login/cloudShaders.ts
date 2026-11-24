export const screenVertex = `attribute vec2 pos;void main(){gl_Position=vec4(pos,0.,1.);}`;

export const volumeFragment = `precision highp float;
uniform vec2 res,center;
uniform float unit,t;
uniform sampler2D art;
uniform vec2 look;
float hsh(vec2 p){vec3 a=fract(vec3(p.xyx)*.1031);a+=dot(a,a.yzx+33.33);return fract((a.x+a.y)*a.z);}
float noise(vec2 p){vec2 i=floor(p),u=fract(p);u=u*u*(3.-2.*u);return mix(mix(hsh(i),hsh(i+vec2(1,0)),u.x),mix(hsh(i+vec2(0,1)),hsh(i+1.),u.x),u.y);}
vec4 dome(vec2 p,vec2 center,vec3 radius,float z){vec2 a=(p-center)/radius.xy;float v=1.-dot(a,a);float nz=sqrt(max(.0001,v));float edge=smoothstep(-.16,.08,v); return vec4(normalize(mix(vec3(0,0,1),normalize(vec3(a/radius.xy,nz/radius.z)),edge)),mix(-.42,z+radius.z*nz,edge));}
vec4 unionDome(vec4 a,vec4 b){float k=.095;float h=clamp(.5+.5*(a.w-b.w)/k,0.,1.);return vec4(normalize(mix(b.xyz,a.xyz,h)),mix(b.w,a.w,h)+k*h*(1.-h));}
vec4 relief(vec2 p){
 vec4 a=dome(p,vec2(-.02,.26),vec3(.46,.43,.47),-.11);
 a=unionDome(a,dome(p,vec2(-.46,.075),vec3(.37,.33,.37),-.035));
 a=unionDome(a,dome(p,vec2(.43,.025),vec3(.44,.33,.41),.025));
 a=unionDome(a,dome(p,vec2(-.61,-.155),vec3(.35,.28,.34),.105));
 a=unionDome(a,dome(p,vec2(.65,-.19),vec3(.30,.26,.31),.08));
 a=unionDome(a,dome(p,vec2(.02,-.24),vec3(.68,.23,.31),.16));return a;
}
vec4 texCloud(vec2 p){
 vec2 uv=vec2(p.x*.5+.5,.5-(p.y-.075)*.5);
 if(any(lessThan(uv,vec2(0)))||any(greaterThan(uv,vec2(1))))return vec4(0);
 return texture2D(art,uv);
}
void main(){
 vec2 p=(gl_FragCoord.xy-center)/unit;
 vec3 col=vec3(.0588,.0902,.1647);
 float river=p.y-.16*sin(3.8*p.x+.27*sin(t))-.15*p.x+.09;
 col+=vec3(.008,.015,.032)*exp(-river*river*22.)*exp(-abs(p.x)*.65);
 if(abs(p.x)<1.12&&p.y>-.68&&p.y<.82){
 vec2 cam=vec2(.105*sin(t)+look.x,.047*cos(t)+look.y);
 // Composite density slices back to front through a relief reconstructed from overlapping ellipsoids.
 vec4 baseHull=relief(p);vec2 slope=clamp(-baseHull.xy/max(.2,baseHull.z),vec2(-1.7),vec2(1.7)); for(int i=0;i<12;i++){
 float z=-.46+float(i)*.09;
 vec2 q=p-cam*z;
 vec4 lobe=vec4(baseHull.xyz,baseHull.w+dot(slope,q-p));
 float skin=lobe.w,local=z-skin;
 float shift=t+z*3.6;
 vec2 wind=.010*vec2(sin(8.*q.y+shift)+.45*cos(13.*q.x-t),cos(7.*q.x-shift)+.48*sin(14.*q.y+t));
 vec2 uv=q+wind+local*.035*lobe.xy;
 vec4 ref=texCloud(uv);
 float front=exp(-local*local/.012),mid=exp(-pow((z-(skin-.20))/.21,2.));
 float density=ref.a*(.49*front+.16*mid+.015);
 vec3 material=ref.rgb;
 float lum=dot(material,vec3(.22,.60,.18));
 vec3 n=lobe.xyz;
 float light=max(dot(n,normalize(vec3(-.55,.68,.57))),0.);
 float grazing=pow(1.-clamp(n.z,0.,1.),2.);
 float space=clamp((z+.5)*.94,0.,1.);
 vec3 dye=mix(material*vec3(.60,.67,.94),material*vec3(.98,1.10,1.27),space);
 dye*=.67+.48*light;
 dye+=vec3(.09,.25,.37)*grazing*(.26+lum);
 // Subpixel filaments follow the curved surface of each lobe, with a second flow at greater depth.
 float weave=uv.y+.125*sin(6.3*uv.x+1.7*n.z+.62*sin(shift))+.14*n.z+.056*sin(14.*uv.x+z*6.-t)+.020*noise(uv*26.+z);
 float line=pow(.5+.5*cos(weave*336.+4.*shift),10.);
 float ribbon=pow(.5+.5*cos(weave*30.+shift*2.),3.);
 dye+=mix(vec3(.13,.34,.42),vec3(.26,.20,.45),n.z)*line*(.16+.68*ribbon)*front*(.2+lum);
 col=mix(col,.76*dye+vec3(.011,.012,.027)*mid,clamp(density,0.,.8));
 }
 vec4 hull=baseHull;vec2 lead=p-cam*hull.w+.009*vec2(sin(p.y*8.+t),cos(p.x*7.-t));
 vec4 detail=texCloud(lead);
 float fiber=max(0.,dot(detail.rgb-texCloud(lead+vec2(.0022,.0014)).rgb,vec3(.28,.53,.19)));
 col+=vec3(.38,.59,.82)*fiber*detail.a;
 }
 gl_FragColor=vec4(col,1.);
}`;

export const starsVertex = `precision highp float;attribute vec4 seed;uniform vec2 res;uniform vec2 center;uniform float unit;uniform float t;uniform float px;varying vec3 tint;varying float power;varying float hero;
void main(){float a=seed.x,b=seed.y,c=seed.z,g=seed.w;
 vec2 p;float fade=1.;
 if(g<.5){
  p=(vec2(a,b)-.5)*res/unit;
 }else if(g<1.5){
  float f=fract(a+t/6.2831853);float x=mix(-1.49,1.49,f);
  float y=.14*x+.18*sin(x*3.8+.27*sin(t))-.095+(b-.5)*(.038+.23*c*c)+.023*sin(12.*x+6.*b-t);
  p=vec2(x,y);fade=smoothstep(0.,.12,f)*(1.-smoothstep(.88,1.,f));
 }else if(g<2.5){
  float angle=6.2831853*a+t;
  p=vec2((1.02+.23*b)*cos(angle),(.36+.09*b)*sin(angle)+.135*cos(angle)+.042*sin(3.*angle+b));
  fade=.45+.42*sin(angle+.5);
 }else{
  p=vec2((a-.5)*2.65,(b-.5)*1.32)+.012*vec2(sin(t+9.*b),cos(t+11.*a));
 }
 float sparkle=pow(.5+.5*cos(2.*t+6.283*a+6.*b),4.);
 hero=max(step(.986,c),step(2.5,g));
 float side=g<.5?.45:1.;
 power=(.28+.72*sparkle)*fade*side*(.54+.48*c);if(g>2.5)power=.40+1.35*sparkle;
 tint=mix(vec3(.37,.63,.95),vec3(.73,.72,1.),b);
 if(c>.975&&b>.52)tint=vec3(.99,.84,.60);
 gl_Position=vec4((center+p*unit)/res*2.-1.,0.,1.);
 gl_PointSize=px*mix(1.1+1.65*c,9.+8.*sparkle,hero);if(g>2.5)gl_PointSize=px*(9.+14.*sparkle);
}`;

export const starsFragment = `precision mediump float;varying vec3 tint;varying float power;varying float hero;
void main(){vec2 p=gl_PointCoord-.5;float d=length(p);float normal=1.-smoothstep(.02,.5,d);
 float star=exp(-d*12.)+.48*exp(-abs(p.x)*75.-abs(p.y)*6.)+.48*exp(-abs(p.y)*75.-abs(p.x)*6.);
 gl_FragColor=vec4(tint*power*mix(normal,star,hero),1.);}`;

export const dustVertex = `precision highp float;attribute vec4 bead;uniform vec2 res,center,look;uniform float unit,px,t;varying vec3 color;varying float gain;
void main(){
 float s=bead.w, z=bead.z;vec2 q=bead.xy;
 q+=vec2(.105*sin(t)+look.x,.047*cos(t)+look.y)*z;
 q+=.012*vec2(sin(q.y*8.+t+z*3.6)+.45*cos(q.x*13.-t),cos(q.x*7.-t-z*3.6)+.48*sin(q.y*14.+t));
 float flow=sin(q.x*10.+q.y*8.-2.*t+z*8.+.8*sin(q.x*8.-t));
 color=mix(vec3(.22,.60,.70),vec3(.52,.40,.88),smoothstep(-.5,.6,q.x+z*.5));
 float near=smoothstep(-.1,.60,z);
 gain=(.09+.28*near)*(.45+.55*pow(.5+.5*flow,3.))*(.65+.65*s);
 gl_PointSize=px*(.64+.78*near+.45*s);
 gl_Position=vec4((center+q*unit)/res*2.-1.,0.,1.);
}`;

export const dustFragment = `precision mediump float;varying vec3 color;varying float gain;void main(){gl_FragColor=vec4(color*gain*(1.-smoothstep(.04,.5,length(gl_PointCoord-.5))),1.);}`;
