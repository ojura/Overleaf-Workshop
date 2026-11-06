#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <jpeglib.h>
#ifndef MOTIONLAB_MAX_PIXELS
#define MOTIONLAB_MAX_PIXELS (16*1024*1024)
#endif
#ifndef MOTIONLAB_MAX_COEFFICIENT_BYTES
#define MOTIONLAB_MAX_COEFFICIENT_BYTES (64*1024*1024)
#endif
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec*1000.0+t.tv_nsec/1e6; }
static FILE *open_file(const char *path, const char *mode) { FILE *f=fopen(path,mode); if(!f){perror(path);exit(2);} return f; }
static unsigned int image_width,image_height;
static int early_dc,initial_dc_al=1;
static unsigned int max_dc_quantizer;
static void check_frame(struct jpeg_decompress_struct *src) {
  if(src->data_precision!=8||src->num_components!=3||!src->image_width||!src->image_height
      ||(uint64_t)src->image_width*src->image_height>MOTIONLAB_MAX_PIXELS) {fputs("8-bit RGB/YCC image exceeds verified limits\n",stderr);exit(8);}
  uint64_t coefficient_bytes=0;
  for(int i=0;i<src->num_components;i++) {
    jpeg_component_info *c=&src->comp_info[i];
    uint64_t mx=(src->image_width+8*src->max_h_samp_factor-1)/(8*src->max_h_samp_factor);
    uint64_t my=(src->image_height+8*src->max_v_samp_factor-1)/(8*src->max_v_samp_factor);
    coefficient_bytes+=64*my*c->v_samp_factor*(mx*c->h_samp_factor+1)*sizeof(JCOEF);
  }
  if(coefficient_bytes>MOTIONLAB_MAX_COEFFICIENT_BYTES) {fputs("JPEG coefficient limit exceeded\n",stderr);exit(8);}
}
static jpeg_scan_info *reading_progression(struct jpeg_decompress_struct *src,struct jpeg_compress_struct *dst) {
  max_dc_quantizer=0;
  for(int i=0;i<src->num_components;i++) {
    JQUANT_TBL *table=src->comp_info[i].quant_table;
    if(!table) {fputs("missing DC quantizer\n",stderr);exit(9);}
    if(table->quantval[0]>max_dc_quantizer)max_dc_quantizer=table->quantval[0];
  }
  if(!early_dc)return NULL;
  initial_dc_al=0;
  /* A DC coefficient changes each 8x8 sample by Q[0]/8. Limit additional
     truncation to two component levels before rounding, at most Al=4. */
  for(int al=1;al<=4;al++)if(max_dc_quantizer*((1U<<al)-1)<=16)initial_dc_al=al;
  if(initial_dc_al==1)return NULL;
  int extra=initial_dc_al>1?initial_dc_al-1:0;
  int count=dst->num_scans+extra-(initial_dc_al==0);
  jpeg_scan_info *scans=calloc(count,sizeof(*scans));
  if(!scans){fputs("scan allocation failed\n",stderr);exit(9);}
  int used=0;
  scans[used]=dst->scan_info[0];scans[used++].Al=initial_dc_al;
  for(int al=initial_dc_al;al>1;al--) {
    scans[used]=dst->scan_info[0];scans[used].Ah=al;scans[used++].Al=al-1;
  }
  for(int i=1;i<dst->num_scans;i++) {
    if(initial_dc_al==0&&dst->scan_info[i].Ss==0&&dst->scan_info[i].Ah>0)continue;
    scans[used++]=dst->scan_info[i];
  }
  if(used!=count){fputs("unexpected progressive scan template\n",stderr);exit(9);}
  dst->scan_info=scans;dst->num_scans=count;
  return scans;
}
static void transcode(const char *input,const char *output) {
  struct jpeg_decompress_struct src; struct jpeg_compress_struct dst;
  struct jpeg_error_mgr se,de; FILE *in=open_file(input,"rb"),*out=open_file(output,"wb");
  src.err=jpeg_std_error(&se); dst.err=jpeg_std_error(&de);
  jpeg_create_decompress(&src); jpeg_create_compress(&dst); jpeg_stdio_src(&src,in);
  for(int i=0;i<16;i++) jpeg_save_markers(&src,JPEG_APP0+i,0xffff);
  jpeg_save_markers(&src,JPEG_COM,0xffff); jpeg_read_header(&src,TRUE);
  check_frame(&src);
  image_width=src.image_width;image_height=src.image_height;
  jvirt_barray_ptr *coeffs=jpeg_read_coefficients(&src);
  jpeg_stdio_dest(&dst,out); jpeg_copy_critical_parameters(&src,&dst);
  jpeg_simple_progression(&dst); dst.optimize_coding=TRUE;
  jpeg_scan_info *reading_scans=reading_progression(&src,&dst);
  dst.write_JFIF_header=FALSE; dst.write_Adobe_marker=FALSE;
  jpeg_write_coefficients(&dst,coeffs);
  for(jpeg_saved_marker_ptr m=src.marker_list;m;m=m->next) jpeg_write_marker(&dst,m->marker,m->data,m->data_length);
  jpeg_finish_compress(&dst); jpeg_finish_decompress(&src);
  jpeg_destroy_compress(&dst); free(reading_scans); jpeg_destroy_decompress(&src); fclose(out);fclose(in);
}
static uint64_t compare(const char *input,const char *output,const char *dump) {
  struct jpeg_decompress_struct a,b; struct jpeg_error_mgr ae,be;
  FILE *af=open_file(input,"rb"),*bf=open_file(output,"rb"),*df=open_file(dump,"wb");
  a.err=jpeg_std_error(&ae);b.err=jpeg_std_error(&be);jpeg_create_decompress(&a);jpeg_create_decompress(&b);
  jpeg_stdio_src(&a,af);jpeg_stdio_src(&b,bf);jpeg_read_header(&a,TRUE);jpeg_read_header(&b,TRUE);
  if(a.image_width!=b.image_width||a.image_height!=b.image_height||a.num_components!=b.num_components||a.data_precision!=b.data_precision||a.jpeg_color_space!=b.jpeg_color_space) { fputs("header mismatch\n",stderr);exit(3); }
  check_frame(&a);check_frame(&b);image_width=a.image_width;image_height=a.image_height;
  jvirt_barray_ptr *ac=jpeg_read_coefficients(&a),*bc=jpeg_read_coefficients(&b);
  uint64_t checked=0;
  for(int c=0;c<a.num_components;c++) {
    jpeg_component_info *x=&a.comp_info[c],*y=&b.comp_info[c];
    if(x->component_id!=y->component_id||x->h_samp_factor!=y->h_samp_factor||x->v_samp_factor!=y->v_samp_factor||x->quant_tbl_no!=y->quant_tbl_no||x->width_in_blocks!=y->width_in_blocks||x->height_in_blocks!=y->height_in_blocks) {fputs("component mismatch\n",stderr);exit(5);}
    /* Saved component tables include the values actually used, even when an
       unused DQT was omitted or a later scan redefined a global table slot. */
    JQUANT_TBL *xq=x->quant_table,*yq=y->quant_table;
    if(!xq||!yq||memcmp(xq->quantval,yq->quantval,sizeof(xq->quantval))) {fputs("referenced quantization mismatch\n",stderr);exit(4);}
    if(xq->quantval[0]>max_dc_quantizer)max_dc_quantizer=xq->quantval[0];
    for(JDIMENSION row=0;row<x->height_in_blocks;row++) {
      JBLOCKARRAY ar=(*a.mem->access_virt_barray)((j_common_ptr)&a,ac[c],row,1,FALSE);
      JBLOCKARRAY br=(*b.mem->access_virt_barray)((j_common_ptr)&b,bc[c],row,1,FALSE);
      for(JDIMENSION col=0;col<x->width_in_blocks;col++) {
        if(memcmp(ar[0][col],br[0][col],sizeof(JBLOCK))) {fputs("coefficient mismatch\n",stderr);exit(6);}
        if(fwrite(ar[0][col],sizeof(JCOEF),DCTSIZE2,df)!=DCTSIZE2){fputs("coefficient write failed\n",stderr);exit(7);}
        checked+=DCTSIZE2;
      }
    }
  }
  jpeg_finish_decompress(&a);jpeg_finish_decompress(&b);jpeg_destroy_decompress(&a);jpeg_destroy_decompress(&b);fclose(af);fclose(bf);if(fclose(df)){perror("coefficient close");exit(7);}
  return checked;
}
int main(int argc,char **argv) {
  if(argc!=4&&(argc!=5||(strcmp(argv[4],"--early-dc")&&strcmp(argv[4],"--verify-only")))) {fputs("usage: coefficients input.jpg progressive.jpg coefficients.bin [--early-dc|--verify-only]\n",stderr);return 2;}
  int verify_only=argc==5&&!strcmp(argv[4],"--verify-only");
  early_dc=argc==5&&!verify_only;
  double t=now_ms(); if(!verify_only)transcode(argv[1],argv[2]);double encoded=verify_only?0:now_ms()-t;
  t=now_ms();uint64_t n=compare(argv[1],argv[2],argv[3]);double checked=now_ms()-t;
  char al[16];if(verify_only)strcpy(al,"null");else snprintf(al,sizeof(al),"%d",initial_dc_al);
  printf("{\"width\":%u,\"height\":%u,\"initialDcAl\":%s,\"maxDcQuantizer\":%u,\"referencedQuantTablesEqual\":true,\"componentSamplingEqual\":true,\"coefficientsEqual\":true,\"coefficientsChecked\":%llu,\"transcodeMs\":%.3f,\"verifyMs\":%.3f}\n",image_width,image_height,al,max_dc_quantizer,(unsigned long long)n,encoded,checked);
  return 0;
}
