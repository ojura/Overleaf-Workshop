#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <jpeglib.h>
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec*1000.0+t.tv_nsec/1e6; }
static FILE *open_file(const char *path, const char *mode) { FILE *f=fopen(path,mode); if(!f){perror(path);exit(2);} return f; }
static unsigned int image_width,image_height;
static void transcode(const char *input,const char *output) {
  struct jpeg_decompress_struct src; struct jpeg_compress_struct dst;
  struct jpeg_error_mgr se,de; FILE *in=open_file(input,"rb"),*out=open_file(output,"wb");
  src.err=jpeg_std_error(&se); dst.err=jpeg_std_error(&de);
  jpeg_create_decompress(&src); jpeg_create_compress(&dst); jpeg_stdio_src(&src,in);
  for(int i=0;i<16;i++) jpeg_save_markers(&src,JPEG_APP0+i,0xffff);
  jpeg_save_markers(&src,JPEG_COM,0xffff); jpeg_read_header(&src,TRUE);
  if(src.data_precision!=8||src.num_components!=3||!src.image_width||!src.image_height
      ||(uint64_t)src.image_width*src.image_height>16*1024*1024) {fputs("8-bit RGB/YCC image exceeds experiment limits\n",stderr);exit(8);}
  uint64_t coefficient_bytes=0;
  for(int i=0;i<src.num_components;i++) {
    jpeg_component_info *c=&src.comp_info[i];
    uint64_t mx=(src.image_width+8*src.max_h_samp_factor-1)/(8*src.max_h_samp_factor);
    uint64_t my=(src.image_height+8*src.max_v_samp_factor-1)/(8*src.max_v_samp_factor);
    coefficient_bytes+=64*my*c->v_samp_factor*(mx*c->h_samp_factor+1)*sizeof(JCOEF);
  }
  if(coefficient_bytes>64*1024*1024) {fputs("JPEG coefficient limit exceeded\n",stderr);exit(8);}
  image_width=src.image_width;image_height=src.image_height;
  jvirt_barray_ptr *coeffs=jpeg_read_coefficients(&src);
  jpeg_stdio_dest(&dst,out); jpeg_copy_critical_parameters(&src,&dst);
  jpeg_simple_progression(&dst); dst.optimize_coding=TRUE;
  dst.write_JFIF_header=FALSE; dst.write_Adobe_marker=FALSE;
  jpeg_write_coefficients(&dst,coeffs);
  for(jpeg_saved_marker_ptr m=src.marker_list;m;m=m->next) jpeg_write_marker(&dst,m->marker,m->data,m->data_length);
  jpeg_finish_compress(&dst); jpeg_finish_decompress(&src);
  jpeg_destroy_compress(&dst); jpeg_destroy_decompress(&src); fclose(out);fclose(in);
}
static uint64_t compare(const char *input,const char *output,const char *dump) {
  struct jpeg_decompress_struct a,b; struct jpeg_error_mgr ae,be;
  FILE *af=open_file(input,"rb"),*bf=open_file(output,"rb"),*df=open_file(dump,"wb");
  a.err=jpeg_std_error(&ae);b.err=jpeg_std_error(&be);jpeg_create_decompress(&a);jpeg_create_decompress(&b);
  jpeg_stdio_src(&a,af);jpeg_stdio_src(&b,bf);jpeg_read_header(&a,TRUE);jpeg_read_header(&b,TRUE);
  if(a.image_width!=b.image_width||a.image_height!=b.image_height||a.num_components!=b.num_components||a.data_precision!=b.data_precision||a.jpeg_color_space!=b.jpeg_color_space) { fputs("header mismatch\n",stderr);exit(3); }
  for(int i=0;i<NUM_QUANT_TBLS;i++) {
    JQUANT_TBL *x=a.quant_tbl_ptrs[i],*y=b.quant_tbl_ptrs[i];
    if((x==NULL)!=(y==NULL)||(x&&memcmp(x->quantval,y->quantval,sizeof(x->quantval)))) {fputs("quantization mismatch\n",stderr);exit(4);}
  }
  jvirt_barray_ptr *ac=jpeg_read_coefficients(&a),*bc=jpeg_read_coefficients(&b);
  uint64_t checked=0;
  for(int c=0;c<a.num_components;c++) {
    jpeg_component_info *x=&a.comp_info[c],*y=&b.comp_info[c];
    if(x->component_id!=y->component_id||x->h_samp_factor!=y->h_samp_factor||x->v_samp_factor!=y->v_samp_factor||x->quant_tbl_no!=y->quant_tbl_no||x->width_in_blocks!=y->width_in_blocks||x->height_in_blocks!=y->height_in_blocks) {fputs("component mismatch\n",stderr);exit(5);}
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
  if(argc!=4) {fputs("usage: coefficients input.jpg progressive.jpg coefficients.bin\n",stderr);return 2;}
  double t=now_ms(); transcode(argv[1],argv[2]);double encoded=now_ms()-t;
  t=now_ms();uint64_t n=compare(argv[1],argv[2],argv[3]);double checked=now_ms()-t;
  printf("{\"width\":%u,\"height\":%u,\"quantTablesEqual\":true,\"componentSamplingEqual\":true,\"coefficientsEqual\":true,\"coefficientsChecked\":%llu,\"transcodeMs\":%.3f,\"verifyMs\":%.3f}\n",image_width,image_height,(unsigned long long)n,encoded,checked);
  return 0;
}
